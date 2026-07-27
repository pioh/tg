// Автообновление зависимостей до latest — с проверкой и АВТО-ОТКАТОМ при поломке.
//
// Шаги: снимок версий → `bun update --latest` (включая мажоры) → если что-то изменилось,
// прогон `typecheck` + `bun test`:
//   • зелёно → оставить обновление, перезапустить сервис, уведомить владельца;
//   • красно → откатить (git checkout package.json bun.lock + bun install), уведомить.
//
// Запуск: `bun run tg update-deps` (или systemd-таймер tg-update-deps.timer — раз в сутки).
// Флаг --no-notify отключает уведомление в Telegram (например при ручном запуске).

import { $ } from "bun";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/paths.ts";
import { listTenants } from "./lib/tenants.ts";

const NOTIFY = !process.argv.includes("--no-notify");

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function logLine(s: string): void {
  console.log(`[update-deps ${ts()}] ${s}`);
}

/** Установленные версии всех зависимостей (из node_modules/<name>/package.json). */
async function versions(): Promise<Record<string, string>> {
  const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as Record<string, Record<string, string>>;
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  const out: Record<string, string> = {};
  for (const n of names) {
    try {
      out[n] = ((await Bun.file(join(REPO_ROOT, "node_modules", n, "package.json")).json()) as { version: string }).version;
    } catch {
      /* пакет не установлен — пропускаем */
    }
  }
  return out;
}

function diffVersions(before: Record<string, string>, after: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const n of Object.keys(after)) if (before[n] !== after[n]) changed.push(`• ${n}: ${before[n] ?? "—"} → ${after[n]}`);
  return changed;
}

/** Уведомить владельца через бота (первый тенант с botToken+botOwnerChatId, предпочтительно mayak). */
async function notifyOwner(text: string): Promise<void> {
  if (!NOTIFY) return;
  try {
    const names = await listTenants();
    const ordered = names.includes("mayak") ? ["mayak", ...names.filter((n) => n !== "mayak")] : names;
    for (const n of ordered) {
      const f = Bun.file(join(REPO_ROOT, "tenants", n, "config.json"));
      if (!(await f.exists())) continue;
      const cfg = (await f.json()) as { botToken?: string; botOwnerChatId?: number };
      if (cfg.botToken && cfg.botOwnerChatId) {
        await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.botOwnerChatId, text }),
        }).catch(() => {});
        return;
      }
    }
  } catch {
    /* уведомление best-effort */
  }
}

/** Провал с ТАКИМ ЖЕ набором версий уже был? Чтобы не слать владельцу одно и то же
 *  каждый день, пока апстрим не выпустит рабочую версию (а мы не починим совместимость). */
async function isNewFailure(which: string, changed: string[]): Promise<boolean> {
  const path = join(REPO_ROOT, "data", "update-deps-last-failure.json");
  const sig = `${which}::${changed.slice().sort().join("|")}`;
  try {
    const prev = (await Bun.file(path).json()) as { sig?: string };
    if (prev.sig === sig) return false;
  } catch {
    /* нет файла или битый — считаем поломку новой */
  }
  await Bun.write(path, JSON.stringify({ sig, at: new Date().toISOString() }, null, 2)).catch(() => {});
  return true;
}

async function main(): Promise<void> {
  logLine("старт: bun update --latest (включая мажоры)");
  const before = await versions();

  const upd = await $`bun update --latest`.cwd(REPO_ROOT).quiet().nothrow();
  if (upd.exitCode !== 0) {
    logLine("bun update упал:\n" + upd.stderr.toString());
    await notifyOwner("⚠️ Автообновление: `bun update --latest` завершился с ошибкой. Зависимости не тронуты.");
    process.exit(1);
  }

  // Что-то реально поменялось? Сверяем УСТАНОВЛЕННЫЕ версии, а не `git diff` против HEAD:
  // апдейтер не коммитит, поэтому после первого же успешного обновления package.json и
  // bun.lock остаются «грязными» навсегда → git diff всегда непустой → каждый запуск
  // впустую гонял проверки, перезапускал сервис и слал владельцу «успех» с пустым списком.
  const changed = diffVersions(before, await versions());
  if (changed.length === 0) {
    logLine("изменений нет — уже latest.");
    process.exit(0);
  }
  logLine("обновлено:\n" + changed.join("\n"));

  logLine("проверка: typecheck");
  const tc = await $`bun run typecheck`.cwd(REPO_ROOT).quiet().nothrow();
  logLine("проверка: bun test");
  const tt = await $`bun test`.cwd(REPO_ROOT).quiet().nothrow();

  if (tc.exitCode === 0 && tt.exitCode === 0) {
    // Успех владельца не беспокоит: рутинный апдейт — это шум. Всё видно в журнале
    // (journalctl --user -u tg-update-deps) и в git diff. Уведомляем только о поломках.
    logLine("зелёно — оставляю обновление и перезапускаю сервис.");
    await $`systemctl --user restart tg-agent`.nothrow();
    process.exit(0);
  }

  const failWhich = tc.exitCode !== 0 ? "typecheck" : "тесты";
  const failRes = tc.exitCode !== 0 ? tc : tt;
  const tail = (failRes.stdout.toString() + failRes.stderr.toString()).slice(-1500);
  logLine(`КРАСНО (${failWhich}) — откатываю (git checkout + bun install).`);
  await $`git checkout -- package.json bun.lock`.cwd(REPO_ROOT).nothrow();
  await $`bun install`.cwd(REPO_ROOT).quiet().nothrow();
  // Одна и та же поломка каждый день — тоже спам: уведомляем только когда набор версий
  // отличается от прошлого проваленного апдейта (иначе просто пишем в журнал).
  if (await isNewFailure(failWhich, changed)) {
    await notifyOwner(`↩️ Автообновление откатил: сломался ${failWhich}. Зависимости вернул на прежние.\n\nПробовал:\n${changed.join("\n")}`);
  } else {
    logLine("та же поломка, что и в прошлый раз — владельца не беспокою.");
  }
  logLine("откат выполнен. Хвост ошибки:\n" + tail);
  process.exit(2);
}

main().catch((e) => {
  logLine("фатально: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
