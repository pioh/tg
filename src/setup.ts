// Мастер настройки `bun run setup` — ведёт ИИ-агент, а не механический скрипт.
//
// Важно (ревью п.2): setup САМ поднимает сервис-хаб, потому что весь функционал
// (bot_status, @BotFather через tg_send_message, monitor_add…) идёт через сервис —
// MCP-прокси без него ответит «Сервис не запущен». Поток:
//   1) вход в Telegram (QR — единственный механический шаг);
//   2) запустить сервис фоном (если ещё не запущен), дождаться /health;
//   3) запустить интерактивную сессию движка (claude/codex) с миссией настройки —
//      её MCP-прокси найдёт хаб по data/service.lock и будет работать;
//   4) по выходу — остановить поднятый нами сервис и подсказать `bun run service`.

import { ensureDataLayout } from "./lib/memory.ts";
import { isLoggedIn, hasSession } from "./telegram/client.ts";
import { loadConfig } from "./lib/config.ts";
import { serviceRunning } from "./lib/lock.ts";
import { REPO_ROOT } from "./lib/paths.ts";

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
   t.me/<username>, попроси нажать Start и написать боту; затем проверь bot_status
   (ownerChatKnown) — сервис сам свяжет чат, когда я напишу.
3. Спроси (одним сообщением, без давления), хочу ли я что-то базовое: интервал
   реакции, последить за кем-то (монитор), периодическую сводку (расписание). Что
   попрошу — настрой инструментами (monitor_add/schedule_add) и зафиксируй правило в
   data/rules; не попрошу — пропусти.
4. Очень кратко перечисли возможности (мониторы, расписания, бот, просмотр фото,
   пассивность по умолчанию, разрешения на ответы) и как запускать сервис (bun run
   service).

Действуй автономно, не заставляй меня выполнять лишние механические шаги.`;

const SETUP_PERSONA = `Сейчас идёт интерактивная НАСТРОЙКА (bun run setup). Будь кратким, дружелюбным,
проактивным: предлагай имена/значения сам, минимизируй мои действия. Не делай
рискованного без подтверждения. Память и правила меняй только в data/.`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Запускает сервис фоном и ждёт, пока поднимется /health. */
async function startServiceChild(): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(["bun", "run", "src/service.ts"], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    if (await serviceRunning()) return proc;
    await sleep(500);
  }
  throw new Error("Сервис не поднялся за 30с. Проверьте вход в Telegram и логи выше.");
}

async function main(): Promise<void> {
  await ensureDataLayout();
  console.log("Настройка tg. Один шаг механический (вход в Telegram), дальше всё делает агент.\n");

  // 1) Вход (неизбежно интерактивный). Запускаем, только если ещё не вошли.
  if (await isLoggedIn()) {
    console.log("✅ Вход в Telegram уже выполнен.\n");
  } else {
    if (await serviceRunning()) {
      console.log("⚠️ Сервис уже запущен (он держит сессию). Остановите его и повторите вход: bun run setup");
      process.exit(1);
    }
    console.log("Шаг входа: откроется вход по QR (отсканируй с телефона). \n");
    const login = Bun.spawn(["bun", "run", "src/login.ts"], { cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await login.exited;
    if (!(await hasSession())) {
      console.log("\nВход не завершён. Запусти мастер снова: bun run setup");
      process.exit(1);
    }
    console.log("");
  }

  // 2) Поднимаем сервис (если ещё не запущен) — без него MCP-инструменты не работают.
  let child: ReturnType<typeof Bun.spawn> | null = null;
  if (await serviceRunning()) {
    console.log("✅ Сервис уже запущен — использую его.\n");
  } else {
    console.log("Запускаю сервис в фоне (нужен для инструментов агента)…\n");
    child = await startServiceChild();
    console.log("✅ Сервис готов.\n");
  }

  // 3) Интерактивная сессия движка. Её MCP-прокси найдёт хаб по data/service.lock.
  const cfg = await loadConfig();
  const engine = cfg.agent;
  console.log(`Запускаю ассистента настройки (${engine})…\n`);
  const cmd = engine === "codex"
    ? ["codex", `${SETUP_PERSONA}\n\n${SETUP_MISSION}`]
    : ["claude", "--append-system-prompt", SETUP_PERSONA, SETUP_MISSION];

  let code = 0;
  try {
    const agent = Bun.spawn(cmd, { cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    code = (await agent.exited) ?? 0;
  } catch {
    console.log(`Не удалось запустить «${cmd[0]}». Установи его и повтори, или открой проект в Claude Code/Codex и скажи: «настрой меня».`);
    code = 1;
  }

  // 4) Останавливаем поднятый нами сервис (если запускали его сами).
  if (child) {
    console.log("\nОстанавливаю временный сервис настройки…");
    child.kill();
    await child.exited.catch(() => {});
  }
  console.log("\nГотово. Запусти агента: bun run service\n");
  process.exit(code);
}

main().catch((err) => {
  console.error("Ошибка мастера:", err instanceof Error ? err.message : err);
  process.exit(1);
});
