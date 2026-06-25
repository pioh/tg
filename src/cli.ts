// Единая точка входа CLI. Запуск: `bun run tg <команда>`.
//
//   login            интерактивный вход в Telegram
//   service [--once] запустить агента-сервис (одной командой)
//   mcp              запустить MCP-сервер вручную (обычно не нужно — его поднимают
//                    Claude Code/Codex/сервис сами)
//   doctor           проверить окружение и готовность
//   qa "<текст>"     дословно записать просьбу человека в data/qa
//   status           показать текущий handoff
//   help             эта справка

import { $ } from "bun";
import { REPO_ROOT, MCP_SERVER_PATH, type TenantContext } from "./lib/paths.ts";
import { join } from "node:path";
import { loadConfig } from "./lib/config.ts";
import { isLoggedIn } from "./telegram/client.ts";
import { serviceRunning } from "./lib/lock.ts";
import { hubCall } from "./lib/rpc.ts";
import { ensureDataLayout, readHandoff, recordQa } from "./lib/memory.ts";
import { installService, uninstallService, serviceDocs } from "./lib/service-install.ts";
import { currentVersion, checkForUpdate, applyUpdate } from "./lib/update.ts";
import { autoMigrateLegacy, createTenant, listTenants, migrateLegacy, tenantContext, tenantExists, withTenant } from "./lib/tenants.ts";

// Выбор тенанта для команд, работающих с рабочей папкой. Имя ОБЯЗАТЕЛЬНО задаётся
// первым аргументом — НИКАКОГО авто-выбора единственного тенанта (это скрытый дефолт).
async function cliTenant(rest: string[]): Promise<{ ctx: TenantContext; rest: string[] }> {
  const names = await listTenants();
  if (names.length === 0) {
    console.error("Нет ни одного пользователя. Создай: bun run tg setup <имя> (или tenant add <имя>).");
    process.exit(1);
  }
  if (rest[0] && names.includes(rest[0])) {
    return { ctx: tenantContext(rest[0], names.indexOf(rest[0])), rest: rest.slice(1) };
  }
  console.error(`Укажи пользователя первым аргументом. Доступные: ${names.join(", ")}.`);
  process.exit(1);
}

function spawnBun(file: string, args: string[] = []): Promise<number> {
  const proc = Bun.spawn(["bun", "run", file, ...args], {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function tryVersion(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || "(есть)";
  } catch {
    return null;
  }
}

async function doctor(): Promise<void> {
  const line = (label: string, val: string) => console.log(`  ${label.padEnd(26)} ${val}`);

  console.log("\n🔎 Проверка окружения tg\n");
  line("Bun", Bun.version);
  line("Корень проекта", REPO_ROOT);

  // Авто-миграция: если осталась старая data/ — переносим в tenants/ (без ручных шагов).
  const migrated = await autoMigrateLegacy().catch(() => null);
  if (migrated) line("Авто-миграция", `✅ data/ → ${migrated}`);

  const claude = await tryVersion(["claude", "--version"]);
  line("Claude Code CLI", claude ?? "❌ не найден (нужен для движка claude)");
  const codex = await tryVersion(["codex", "--version"]);
  line("Codex CLI", codex ?? "⚠️ не найден (нужен для движка codex)");

  // Пер-тенантная проверка (у каждого своя сессия/бот/конфиг).
  const tenants = await listTenants();
  if (!tenants.length) {
    line("Пользователи", "нет — создай: bun run tg setup <имя>");
  } else {
    line("Пользователи", tenants.join(", "));
    for (let i = 0; i < tenants.length; i++) {
      const ctx = tenantContext(tenants[i]!, i);
      await withTenant(ctx, async () => {
        const cfg = await loadConfig();
        const running = await serviceRunning();
        let who = "";
        if (running) {
          try {
            const w = (await hubCall("whoami")) as { name?: string; username?: string | null };
            who = `✅ ${w.name}${w.username ? ` (@${w.username})` : ""} (через хаб)`;
          } catch {
            who = "⚠️ хаб не ответил";
          }
        } else {
          const me = await isLoggedIn().catch(() => null);
          who = me ? `✅ ${me.name}${me.username ? ` (@${me.username})` : ""}` : `❌ нет входа — bun run tg login ${ctx.name}`;
        }
        line(`  • ${ctx.name}`, `${who} · движок ${cfg.agent}/${cfg.model} · ${running ? `сервис pid ${running.pid}` : "сервис не запущен"}`);
      });
    }
  }

  console.log("\n🔑 Аутентификация движка\n");
  if (process.env.ANTHROPIC_API_KEY) {
    line("ANTHROPIC_API_KEY", "⚠️ задан — оплата пойдёт через API, НЕ через подписку. unset для подписки.");
  } else {
    line("ANTHROPIC_API_KEY", "не задан — будет использована подписка Claude Code ✅");
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    line("ANTHROPIC_AUTH_TOKEN", "⚠️ задан — тоже перебивает подписку. unset для подписки.");
  }
  line(
    "CLAUDE_CODE_OAUTH_TOKEN",
    process.env.CLAUDE_CODE_OAUTH_TOKEN ? "задан ✅" : "не задан (ок, если уже сделан `claude` login)",
  );
  console.log(
    "\nЕсли движок claude не видит подписку — выполните `claude setup-token` и/или `unset ANTHROPIC_API_KEY`.\n",
  );
}

// Предпубликационная проверка: нет ли утечек личных данных в ОТСЛЕЖИВАЕМЫХ git файлах.
async function prepublish(): Promise<void> {
  console.log("\n🔒 Предпубликационная проверка (только git-tracked файлы)\n");
  const files = (await $`git ls-files`.text()).split("\n").filter(Boolean);
  const problems: string[] = [];

  const dataTracked = files.filter((f) => (f.startsWith("data/") && f !== "data/.gitkeep") || f.startsWith("tenants/"));
  if (dataTracked.length) problems.push(`личные папки отслеживаются git: ${dataTracked.join(", ")}`);

  const specTracked = files.filter((f) => f.startsWith("spec/"));
  if (specTracked.length) problems.push(`spec/ отслеживается git (личные заметки): ${specTracked.join(", ")}`);

  if (files.includes(".env")) problems.push(".env отслеживается git");

  // Секрет-сканер по содержимому: bot-токен (123456789:AA...).
  const botToken = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;
  for (const f of files) {
    if (f === "bun.lock") continue;
    const txt = await Bun.file(join(REPO_ROOT, f)).text().catch(() => "");
    if (botToken.test(txt)) problems.push(`похоже на bot-токен в ${f}`);
  }

  console.log(`  личные папки чисто: ${dataTracked.length ? "❌" : "✅"} (data/, tenants/ не в git)`);
  console.log(`  spec/ не в git:     ${specTracked.length ? "❌" : "✅"}`);
  console.log(`  секретов в коде:    ${problems.some((p) => p.includes("токен")) ? "❌" : "✅ не найдено"}`);
  console.log(`  hub-auth включён:   ✅ (bearer-токен, см. lib/lock.ts)`);

  if (problems.length) {
    console.log("\n❌ Найдены проблемы:\n" + problems.map((p) => `  - ${p}`).join("\n") + "\n");
    process.exit(1);
  }
  console.log("\n✅ Готово к публикации: личные данные не утекают.\n");
}

// Запущен ли сервис хоть у одного тенанта (проверяем lock КАЖДОГО в его контексте).
// install-service не должен зависеть от какого-то одного per-tenant lock.
async function anyServiceRunning(): Promise<boolean> {
  const names = await listTenants();
  for (let i = 0; i < names.length; i++) {
    const ctx = tenantContext(names[i]!, i);
    if (await withTenant(ctx, () => serviceRunning())) return true;
  }
  return false;
}

async function installServiceCmd(): Promise<void> {
  const running = await anyServiceRunning();
  // Если экземпляр уже работает вручную — только включаем (не стартуем второй).
  const res = await installService(!running);
  console.log("");
  for (const m of res.messages) console.log("  " + m);
  if (running) console.log("  ⚠️ Сейчас запущен ручной экземпляр — остановите его (Ctrl+C), сервис подхватит автозапуск.");
  console.log("\n" + res.docs + "\n");
}

async function uninstallServiceCmd(): Promise<void> {
  const res = await uninstallService();
  console.log("");
  for (const m of res.messages) console.log("  " + m);
  console.log("");
}

async function versionCmd(): Promise<void> {
  console.log(`tg ${await currentVersion()}`);
  const ch = await checkForUpdate();
  if (!ch.ok) console.log(`(не удалось проверить обновления: ${ch.error})`);
  else if (ch.hasUpdate) console.log(`🆕 Доступна версия ${ch.latest}. Обновить: bun run tg update`);
  else console.log("✅ Установлена последняя версия.");
}

async function updateCmd(): Promise<void> {
  console.log("Обновляю (git pull + bun install)…");
  const r = await applyUpdate();
  if (!r.ok) {
    console.error("❌ " + r.error);
    process.exit(1);
  }
  console.log(`✅ Обновлено до ${r.version}. Перезапусти сервис, чтобы применить (если запущен): systemctl --user restart tg-agent / launchctl … / Ctrl+C + bun run service.`);
}

async function tenantCmd(rest: string[]): Promise<void> {
  const [sub, name] = rest;
  if (sub === "list" || !sub) {
    const names = await listTenants();
    if (!names.length) {
      console.log("Тенантов нет. Создай: bun run tg tenant add <имя>  (или мигрируй: bun run tg tenant migrate-legacy <имя>)");
      return;
    }
    console.log("Тенанты (по одному пользователю на папку tenants/<имя>):\n");
    for (const n of names) console.log(`  ${n}`);
    return;
  }
  if (sub === "add") {
    if (!name) {
      console.error("Укажи имя: bun run tg tenant add <имя>");
      process.exit(1);
    }
    if (await tenantExists(name)) {
      console.log(`Тенант «${name}» уже есть.`);
      return;
    }
    await createTenant(name);
    console.log(`✅ Создан тенант «${name}». Войди в его Telegram: bun run tg login ${name}, затем настрой: bun run tg setup ${name}.`);
    return;
  }
  if (sub === "migrate-legacy") {
    if (!name) {
      console.error("Укажи имя: bun run tg tenant migrate-legacy <имя>  (перенесёт текущую data/ в tenants/<имя>)");
      process.exit(1);
    }
    // Проверяем занятость по ВСЕМ тенантам (а не по текущему tenant-lock, которого тут
    // ещё нет: миграция переносит ЯВНУЮ старую data/ в первого тенанта). Сервис мог бы
    // держать другого тенанта — но саму data/ он уже не использует. Главное — не дать
    // запущенному экземпляру потерять данные при rename.
    if (await anyServiceRunning()) {
      console.error("⚠️ Сервис запущен. Останови его перед миграцией, иначе можно потерять данные.");
      process.exit(1);
    }
    const dest = await migrateLegacy(name);
    console.log(`✅ Перенёс data/ → ${dest}. Запусти сервис: bun run service.`);
    return;
  }
  console.error(`Неизвестно: tenant ${sub}. Доступно: list, add <имя>, migrate-legacy <имя>`);
  process.exit(1);
}

function help(): void {
  console.log(
    `tg — ИИ-агент для личного Telegram\n\n` +
      `Использование: bun run tg <команда>\n\n` +
      `  setup [имя]           мастер настройки тенанта (вход + бот + базовое) — начните с него\n` +
      `  login <имя>           интерактивный вход в Telegram (для тенанта <имя>)\n` +
      `  tenant <list|add <имя>|migrate-legacy <имя>>  управление пользователями (тенантами)\n` +
      `  service [--once]       запустить агента-сервис (--once — один проход)\n` +
      `  install-service       поставить как фоновый сервис (systemd/launchd) + автозапуск\n` +
      `  uninstall-service     удалить фоновый сервис\n` +
      `  service-help          как смотреть логи / останавливать / перезапускать сервис\n` +
      `  version               версия + проверка обновлений\n` +
      `  update                обновиться до последней версии (git pull + bun install)\n` +
      `  mcp                   запустить MCP-сервер вручную\n` +
      `  doctor [--prepublish] проверить окружение (или готовность к публикации)\n` +
      `  qa <имя> "<текст>"    записать просьбу человека дословно (в папку пользователя)\n` +
      `  status <имя>          показать handoff пользователя\n` +
      `  help                  эта справка\n` +
      `\n<имя> — пользователь (tenant); указывай явно (авто-выбора единственного нет).\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      process.exit(await spawnBun(join("src", "setup.ts"), rest));
      break;
    case "login":
      process.exit(await spawnBun(join("src", "login.ts"), rest));
      break;
    case "tenant":
    case "tenants":
      await tenantCmd(rest);
      break;
    case "service":
      process.exit(await spawnBun(join("src", "service.ts"), rest));
      break;
    case "install-service":
      await installServiceCmd();
      break;
    case "uninstall-service":
      await uninstallServiceCmd();
      break;
    case "service-help":
    case "service-docs":
      console.log("\n" + serviceDocs() + "\n");
      break;
    case "version":
    case "--version":
    case "-v":
      await versionCmd();
      break;
    case "update":
      await updateCmd();
      break;
    case "mcp":
      process.exit(await spawnBun(MCP_SERVER_PATH));
      break;
    case "doctor":
      if (rest.includes("--prepublish")) await prepublish();
      else await doctor();
      break;
    case "qa": {
      const { ctx, rest: r } = await cliTenant(rest);
      const text = r.join(" ").trim();
      if (!text) {
        console.error('Укажите текст: bun run tg qa [имя] "..."');
        process.exit(1);
      }
      const file = await withTenant(ctx, () => recordQa(text, "cli"));
      console.log(`Записано дословно в ${file}`);
      break;
    }
    case "status": {
      const { ctx } = await cliTenant(rest);
      await withTenant(ctx, async () => {
        await ensureDataLayout();
        console.log(await readHandoff());
      });
      break;
    }
    case "help":
    case undefined:
      help();
      break;
    default:
      console.error(`Неизвестная команда: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Ошибка:", err instanceof Error ? err.message : err);
  process.exit(1);
});
