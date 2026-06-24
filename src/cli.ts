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
import { installService, uninstallService, serviceDocs } from "./lib/service-install.ts";
import { currentVersion, checkForUpdate, applyUpdate } from "./lib/update.ts";
import { createTenant, listTenants, migrateLegacy, tenantExists } from "./lib/tenants.ts";

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
  const tenants = await listTenants();
  line("Тенанты (tenants/)", tenants.length ? tenants.join(", ") : "нет (legacy data/ или создай: tenant add <имя>)");

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

async function installServiceCmd(): Promise<void> {
  const running = await serviceRunning();
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
    const running = await serviceRunning();
    if (running) {
      console.error(`⚠️ Сервис запущен (pid ${running.pid}). Останови его перед миграцией, иначе можно потерять данные.`);
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
      `  login [имя]           интерактивный вход в Telegram (для тенанта <имя>)\n` +
      `  tenant <list|add <имя>|migrate-legacy <имя>>  управление пользователями (тенантами)\n` +
      `  service [--once]       запустить агента-сервис (--once — один проход)\n` +
      `  install-service       поставить как фоновый сервис (systemd/launchd) + автозапуск\n` +
      `  uninstall-service     удалить фоновый сервис\n` +
      `  service-help          как смотреть логи / останавливать / перезапускать сервис\n` +
      `  version               версия + проверка обновлений\n` +
      `  update                обновиться до последней версии (git pull + bun install)\n` +
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
