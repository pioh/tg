// Мастер настройки `bun run setup [имя]` — ведёт ИИ-агент. МУЛЬТИТЕНАНТНЫЙ: настраивает
// ОДНОГО пользователя (тенанта) — его папку tenants/<имя> со своей сессией и ботом.
//
// Поток:
//   1) определить имя тенанта (аргумент или спросить); создать папку, если нет;
//   2) вход в Telegram этого тенанта (QR — единственный механический шаг);
//   3) поднять ВРЕМЕННЫЙ сервис только для этого тенанта (TG_ONLY_TENANT), дождаться хаба;
//   4) запустить интерактивную сессию движка (claude/codex) с миссией настройки — её
//      MCP-прокси найдёт хаб тенанта (через TG_DATA_DIR=tenants/<имя>);
//   5) остановить временный сервис; предложить установить постоянный фоновый сервис.

import { ensureDataLayout } from "./lib/memory.ts";
import { isLoggedIn, hasSession } from "./telegram/client.ts";
import { loadConfig } from "./lib/config.ts";
import { serviceRunning } from "./lib/lock.ts";
import { REPO_ROOT, tenantDir, type TenantContext } from "./lib/paths.ts";
import { createTenant, tenantContext, tenantExists, withTenant } from "./lib/tenants.ts";
import { installService, serviceDocs, currentOS } from "./lib/service-install.ts";

const SETUP_MISSION = `Ты — дружелюбный ассистент настройки личного Telegram-агента (проект tg).
Проведи меня через настройку с МИНИМУМОМ действий с моей стороны: думай и предлагай
сам, спрашивай только когда реально нужно моё решение или действие.

Сделай по шагам, по-русски, кратко:
1. Прочитай rules/00-agent-core.md, rules/10-memory-hierarchy.md, rules/25-bot.md и
   вызови mem_bootstrap — пойми текущее состояние и память.
2. Проверь bot_status. Если сервисный бот ещё НЕ настроен — предложи создать его и
   САМ придумай хорошее имя и @username (на основе моего профиля, tg_whoami; username
   должен заканчиваться на 'bot'). Покажи предложение, спроси короткое «ок?».
   После подтверждения создай бота сам: пиши @BotFather через tg_send_message
   (/newbot → имя → username; читай ответы tg_get_history; если username занят —
   придумай другой и повтори), забери токен и сохрани bot_set_token. Дай мне ссылку
   t.me/<username>, попроси нажать Start и написать боту; затем проверь bot_status.
3. Спроси (одним сообщением, без давления), хочу ли я что-то базовое: последить за
   кем-то (монитор), периодическую сводку (расписание), общий чат с ботом для семьи
   (тогда подскажи: добавь бота в группу и отправь там /here, и выключи privacy-mode
   у @BotFather). Что попрошу — настрой инструментами и зафиксируй правило в data/rules.
4. Очень кратко перечисли возможности и упомяни команды бота /help и /start. После
   твоего завершения мастер сам предложит установить фоновый сервис.

Действуй автономно, не заставляй меня выполнять лишние механические шаги.`;

const SETUP_PERSONA = `Сейчас идёт интерактивная НАСТРОЙКА (bun run setup). Будь кратким, дружелюбным,
проактивным: предлагай имена/значения сам, минимизируй мои действия. Не делай
рискованного без подтверждения. Память и правила меняй только в data/.`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ask(question: string): string {
  const a = prompt(question);
  return (a ?? "").trim();
}
function askYesNo(question: string, def = true): boolean {
  const ans = prompt(`${question} ${def ? "[Y/n]" : "[y/N]"} `);
  if (ans === null) return def;
  const s = ans.trim().toLowerCase();
  if (s === "") return def;
  return s === "y" || s === "yes" || s === "д" || s === "да";
}

/** Свободный TCP-порт (чтобы временный сервис не конфликтовал с уже запущенным на 8765). */
function findFreePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  if (typeof p !== "number" || p <= 0) throw new Error("не удалось выделить свободный порт");
  return p;
}

/** Запускает сервис ТОЛЬКО для этого тенанта (TG_ONLY_TENANT) на свободном порту и ждёт
 *  его хаб (serviceRunning читает порт из lock тенанта, так что фактический порт неважен). */
async function startServiceChild(ctx: TenantContext): Promise<ReturnType<typeof Bun.spawn>> {
  const port = findFreePort();
  const proc = Bun.spawn(["bun", "run", "src/service.ts"], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TG_ONLY_TENANT: ctx.name, TG_HUB_PORT: String(port) },
  });
  for (let i = 0; i < 60; i++) {
    if (await withTenant(ctx, () => serviceRunning())) return proc;
    await sleep(500);
  }
  throw new Error("Сервис не поднялся за 30с. Проверьте вход в Telegram и логи выше.");
}

async function offerServiceInstall(externalServiceRunning: boolean): Promise<void> {
  const os = currentOS();
  if (os === "win32" || os === "other") {
    console.log("\nЧтобы агент работал в фоне постоянно (Windows):\n");
    console.log(serviceDocs(os) + "\n");
    return;
  }
  const mgr = os === "linux" ? "systemd --user" : "launchd";
  if (!askYesNo(`\nУстановить агента как фоновый сервис (${mgr}), чтобы работал постоянно и сам стартовал после перезагрузки?`)) {
    console.log("Ок, не ставлю. Можно потом: bun run tg install-service\n");
    return;
  }
  const res = await installService(!externalServiceRunning);
  console.log("");
  for (const m of res.messages) console.log("  " + m);
  if (externalServiceRunning) console.log("  ⚠️ Перезапусти сервис, чтобы он подхватил нового пользователя: systemctl --user restart tg-agent (или launchctl).");
  console.log("\n" + res.docs + "\n");
}

async function main(): Promise<void> {
  console.log("Настройка tg. Один шаг механический (вход в Telegram), дальше всё делает агент.\n");

  // 1) Имя тенанта (пользователя/папки). Без дефолтов — спрашиваем явно.
  let name = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "";
  while (!/^[A-Za-z0-9._-]+$/.test(name)) {
    name = ask("Имя для этого пользователя/папки (латиницей, напр. me, work, family): ");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) console.log("Только латиница, цифры и . _ - — попробуй ещё раз.");
  }
  if (!(await tenantExists(name))) {
    await createTenant(name);
    console.log(`Создал папку tenants/${name}.\n`);
  }
  const ctx = tenantContext(name, 0);

  // Дальше всё, что читает папку тенанта, — в его контексте.
  await withTenant(ctx, () => ensureDataLayout());

  const preRunning = Boolean(await withTenant(ctx, () => serviceRunning()));

  // 2) Вход в Telegram этого тенанта.
  if (preRunning) {
    console.log(`✅ Сервис тенанта «${name}» уже запущен — вход не требуется.\n`);
  } else if (await withTenant(ctx, () => isLoggedIn())) {
    console.log("✅ Вход в Telegram уже выполнен.\n");
  } else {
    console.log("Шаг входа: откроется вход по QR (отсканируй с телефона).\n");
    const login = Bun.spawn(["bun", "run", "src/login.ts", name], { cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await login.exited;
    if (!(await withTenant(ctx, () => hasSession()))) {
      console.log(`\nВход не завершён. Запусти мастер снова: bun run setup ${name}`);
      process.exit(1);
    }
    console.log("");
  }

  // 3) Поднимаем временный сервис ТОЛЬКО для этого тенанта (нужен для инструментов агента).
  let child: ReturnType<typeof Bun.spawn> | null = null;
  if (preRunning) {
    console.log("✅ Сервис уже запущен — использую его.\n");
  } else {
    console.log("Запускаю сервис в фоне (нужен для инструментов агента)…\n");
    child = await startServiceChild(ctx);
    console.log("✅ Сервис готов.\n");
  }

  // 4) Интерактивная сессия движка. MCP-прокси найдёт хаб тенанта через TG_DATA_DIR.
  const engine = (await withTenant(ctx, () => loadConfig())).agent;
  console.log(`Запускаю ассистента настройки (${engine})…\n`);
  const cmd = engine === "codex"
    ? ["codex", `${SETUP_PERSONA}\n\n${SETUP_MISSION}`]
    : ["claude", "--append-system-prompt", SETUP_PERSONA, SETUP_MISSION];

  let code = 0;
  try {
    const agent = Bun.spawn(cmd, {
      cwd: REPO_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TG_DATA_DIR: tenantDir(name) },
    });
    code = (await agent.exited) ?? 0;
  } catch {
    console.log(`Не удалось запустить «${cmd[0]}». Установи его и повтори, или открой проект в Claude Code/Codex и скажи: «настрой меня».`);
    code = 1;
  }

  // 5) Останавливаем временный сервис (если запускали сами).
  if (child) {
    console.log("\nОстанавливаю временный сервис настройки…");
    child.kill();
    await child.exited.catch(() => {});
  }

  // 6) Предлагаем поставить постоянный фоновый сервис (он поднимет ВСЕХ тенантов).
  await offerServiceInstall(preRunning).catch((e) => console.log("Установка сервиса пропущена:", e instanceof Error ? e.message : e));

  console.log(`Готово. Запустить всех пользователей вручную: bun run service. Добавить ещё одного: bun run setup <имя>.\n`);
  process.exit(code);
}

main().catch((err) => {
  console.error("Ошибка мастера:", err instanceof Error ? err.message : err);
  process.exit(1);
});
