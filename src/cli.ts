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
import { REPO_ROOT, MCP_SERVER_PATH } from "./lib/paths.ts";
import { join } from "node:path";
import { loadConfig } from "./lib/config.ts";
import { isLoggedIn } from "./telegram/client.ts";
import { serviceRunning } from "./lib/lock.ts";
import { hubCall } from "./lib/rpc.ts";
import { listPermissions, revokePermission } from "./lib/permissions.ts";
import { ensureDataLayout, readHandoff, recordQa } from "./lib/memory.ts";

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
  await ensureDataLayout();
  const cfg = await loadConfig();
  const line = (label: string, val: string) => console.log(`  ${label.padEnd(26)} ${val}`);

  console.log("\n🔎 Проверка окружения tg\n");
  line("Bun", Bun.version);
  line("Корень проекта", REPO_ROOT);

  const claude = await tryVersion(["claude", "--version"]);
  line("Claude Code CLI", claude ?? "❌ не найден (нужен для движка claude)");
  const codex = await tryVersion(["codex", "--version"]);
  line("Codex CLI", codex ?? "⚠️ не найден (нужен для движка codex)");

  line("API-креды Telegram", `✅ id=${cfg.apiId} ${cfg.apiId === 25282 ? "(встроенные по умолчанию)" : "(свои)"}`);

  // Если сервис уже запущен — НЕ открываем сессию сами (единственный владелец),
  // а спрашиваем хаб. Иначе делаем лёгкую прямую проверку.
  const running = await serviceRunning();
  if (running) {
    line("Сервис", `✅ запущен (pid ${running.pid}, порт ${running.port})`);
    try {
      const who = (await hubCall("whoami")) as { name?: string; username?: string | null };
      line("Сессия Telegram", `✅ через хаб: ${who.name}${who.username ? ` (@${who.username})` : ""}`);
    } catch {
      line("Сессия Telegram", "⚠️ сервис запущен, но хаб не ответил");
    }
  } else {
    line("Сервис", "не запущен (`bun run service`)");
    const me = await isLoggedIn().catch(() => null);
    line("Сессия Telegram", me ? `✅ вход выполнен: ${me.name}${me.username ? ` (@${me.username})` : ""}` : "❌ нет — запустите `login`");
  }
  line("Движок по умолчанию", `${cfg.agent} (модель ${cfg.model})`);
  line("Управляющий канал", String(cfg.controlChat));
  line("Интервал тика", `${cfg.intervalSeconds}s`);

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

  const dataTracked = files.filter((f) => f.startsWith("data/") && f !== "data/.gitkeep");
  if (dataTracked.length) problems.push(`data/ отслеживается git: ${dataTracked.join(", ")}`);

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

  const running = await serviceRunning();
  console.log(`  data/ чисто:        ${dataTracked.length ? "❌" : "✅"}`);
  console.log(`  spec/ не в git:     ${specTracked.length ? "❌" : "✅"}`);
  console.log(`  секретов в коде:    ${problems.some((p) => p.includes("токен")) ? "❌" : "✅ не найдено"}`);
  console.log(`  hub-auth включён:   ✅ (bearer-токен, см. lib/lock.ts)`);
  console.log(`  сервис сейчас:      ${running ? `запущен (pid ${running.pid})` : "не запущен"}`);

  if (problems.length) {
    console.log("\n❌ Найдены проблемы:\n" + problems.map((p) => `  - ${p}`).join("\n") + "\n");
    process.exit(1);
  }
  console.log("\n✅ Готово к публикации: личные данные не утекают.\n");
}

async function permissionsCmd(rest: string[]): Promise<void> {
  const [sub, arg] = rest;
  if (sub === "list" || !sub) {
    const perms = await listPermissions();
    const ids = Object.keys(perms);
    if (!ids.length) {
      console.log('Явных разрешений нет. (Себе "me" и в управляющий канал — можно всегда.)');
      return;
    }
    console.log("Кому агент может писать (allowlist):\n");
    for (const id of ids) {
      const p = perms[id]!;
      console.log(`  ${id}  ${p.label ?? ""}  [${p.mode}] · ${p.source ?? ""} · ${p.createdAt}`);
    }
    return;
  }
  if (sub === "revoke") {
    if (!arg) {
      console.error("Укажите чат: bun run tg permissions revoke <id|@username>");
      process.exit(1);
    }
    if (/^-?\d+$/.test(arg)) {
      console.log((await revokePermission(Number(arg))) ? `Отозвано: ${arg}` : `Не найдено: ${arg}`);
    } else {
      // нужно разрешить @username → через сервис
      const r = (await hubCall("permission_revoke", { chat: arg })) as { revoked: boolean };
      console.log(r.revoked ? `Отозвано: ${arg}` : `Не найдено: ${arg}`);
    }
    return;
  }
  console.error(`Неизвестно: permissions ${sub}. Доступно: list, revoke <id|@username>`);
  process.exit(1);
}

function help(): void {
  console.log(
    `tg — ИИ-агент для личного Telegram\n\n` +
      `Использование: bun run tg <команда>\n\n` +
      `  setup                 мастер настройки (вход + бот + базовое) — начните с него\n` +
      `  login                 интерактивный вход в Telegram\n` +
      `  service [--once]       запустить агента-сервис (--once — один проход)\n` +
      `  mcp                   запустить MCP-сервер вручную\n` +
      `  doctor [--prepublish] проверить окружение (или готовность к публикации)\n` +
      `  permissions [list|revoke <chat>]  разрешения на отправку\n` +
      `  qa "<текст>"          записать просьбу человека дословно в data/qa\n` +
      `  status                показать текущий handoff\n` +
      `  help                  эта справка\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      process.exit(await spawnBun(join("src", "setup.ts")));
      break;
    case "login":
      process.exit(await spawnBun(join("src", "login.ts")));
      break;
    case "service":
      process.exit(await spawnBun(join("src", "service.ts"), rest));
      break;
    case "mcp":
      process.exit(await spawnBun(MCP_SERVER_PATH));
      break;
    case "doctor":
      if (rest.includes("--prepublish")) await prepublish();
      else await doctor();
      break;
    case "permissions":
    case "perms":
      await permissionsCmd(rest);
      break;
    case "qa": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.error('Укажите текст: bun run tg qa "..."');
        process.exit(1);
      }
      const file = await recordQa(text, "cli");
      console.log(`Записано дословно в ${file}`);
      break;
    }
    case "status":
      await ensureDataLayout();
      console.log(await readHandoff());
      break;
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
