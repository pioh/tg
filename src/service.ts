// Сервис — ЕДИНСТВЕННЫЙ владелец Telegram-сессии и «живой» обработчик.
// Запуск: `bun run service` (один экземпляр — гарантируется lock-файлом). Интерактивные
// агенты и live-агент работают с Telegram только через него (RPC-хаб, bearer-токен).
//
// Реакция мгновенная: бот — long-poll; чаты/мониторы/расписания — детектор ~3с.
// События докидываются в ОДНУ непрерывную сессию агента НА ЛЕТУ (streaming) — без
// ожидания конца текущего хода. Сессия переживает рестарт (id на диске) и падения
// (watchdog: перезапуск с resume). Новую сессию создаёт только агент (session_reset)
// или человек (/new, /compact).
//
// Команды человека боту: /new, /compact, /context, /model <m>, /effort <lvl>.
// Флаг --once: один проход (bot+детектор) и выход — для проверки/cron.

import { requireConfig, saveConfig, normalizeEffort } from "./lib/config.ts";
import { createClient, hasSession } from "./telegram/client.ts";
import { ensureDataLayout, appendProgress } from "./lib/memory.ts";
import { loadState, updateState, type AgentUsage } from "./lib/state.ts";
import { acquireLock, releaseLock, type LockInfo } from "./lib/lock.ts";
import { HUB_PORT } from "./lib/rpc.ts";
import { buildHandlers, startHubServer, type Handlers, type AgentSessionCtx } from "./hub.ts";
import { buildSystemAppend } from "./agent/prompt.ts";
import { createAgentSession, type AgentSession, type TurnUsage } from "./agent/session.ts";
import { log, fail } from "./lib/log.ts";

const DETECT_SECONDS = Number(process.env.TG_DETECT_SECONDS ?? 3);
const PROGRESS_THROTTLE_MS = 6000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LIVE_INTRO = `Ты — живая сессия агента личного Telegram. Тебе НА ЛЕТУ приходят события (новые
сообщения, команды, сработавшие мониторы/расписания) — реагируй по правилам и памяти.
Команды человека из бота — отвечай через bot_send; долгие задачи — показывай прогресс
через bot_progress (💭). Мониторы — по их action (на монитор один ответ на пачку, если
правило не велит иначе). 👀-реакцию ставит только БОТ в своей личке (что принял твоё
сообщение) — сервис делает это сам; на сообщения других людей реакции НЕ ставь. НЕ
отмечай прочитанным. По умолчанию пассивен. Отправка в чужие чаты разрешена кодом только при
явном разрешении (монитор reply / permission_grant). Значимое — в handoff/progress.
Следи за контекстом (session_status); если переполняется — актуализируй handoff/память
и session_reset.\n`;

let stopping = false;
let restarting = false;
let inflight = 0; // сколько ходов в очереди/в работе
let needIntro = true;
let lastProgressAt = 0;

// рантайм-координаты хаба (lock-файл)
let hubPort = HUB_PORT;
let hubToken = "";
let currentHandlers: Handlers | undefined;

// модель/усилие (меняются командами на лету)
let currentModel = "opus";
let currentEffort: string | undefined;
let engine: "claude" | "codex" = "claude";

// непрерывная сессия агента
function freshUsage(): AgentUsage {
  return { turns: 0, contextTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, startedAt: new Date().toISOString() };
}
let agentSessionId: string | undefined;
let codexThreadId: string | undefined;
let agentUsage: AgentUsage = freshUsage();
let session: AgentSession;

// отложенное пересоздание сессии (применяется в простое)
let pendingMode: "fresh" | "keep" | null = null;
let resetRequested = false; // агент попросил session_reset

const sessionCtx: AgentSessionCtx = {
  getSessionId: () => agentSessionId,
  getUsage: () => agentUsage,
  requestReset: () => {
    resetRequested = true;
  },
};

async function persistAgent(): Promise<void> {
  await updateState((st) => {
    st.agentSessionId = agentSessionId;
    st.codexThreadId = codexThreadId;
    st.agentUsage = agentUsage;
  });
}

async function startSession(resume?: string): Promise<void> {
  const append = await buildSystemAppend();
  needIntro = true;
  agentSessionId = resume;
  session = createAgentSession({
    engine,
    model: currentModel,
    effort: currentEffort,
    append,
    resume,
    hubPort,
    hubToken,
    codexResumeThreadId: codexThreadId,
    onTurnEnd,
    onThreadId: (id) => {
      codexThreadId = id;
      void persistAgent();
    },
    onError: onSessionError,
  });
}

async function restart(resume: string | undefined, fresh: boolean): Promise<void> {
  await session.close();
  if (fresh) {
    agentUsage = freshUsage();
    codexThreadId = undefined;
  }
  await startSession(resume);
  await persistAgent();
}

// Watchdog: сессия неожиданно упала — перезапуск с resume и backoff. Защита от
// плотного краш-цикла: при N падениях подряд за минуту останавливаемся и сообщаем раз.
let crashCount = 0;
let lastCrashTs = 0;
let crashStopped = false;
async function onSessionError(err: unknown): Promise<void> {
  if (stopping || restarting || crashStopped) return;
  restarting = true;
  const now = Date.now();
  if (now - lastCrashTs > 60000) crashCount = 0; // окно сброса
  lastCrashTs = now;
  crashCount++;
  log("watchdog: сессия агента упала:", err instanceof Error ? err.message : err);
  if (crashCount > 5) {
    crashStopped = true;
    restarting = false;
    log("watchdog: 5 падений подряд — останавливаю перезапуск. Проверьте модель/окружение.");
    await currentHandlers?.bot_send?.({ text: "⛔ Агент-сессия падает повторно. Перезапуск остановлен — проверь /model и логи сервиса." }).catch(() => {});
    return;
  }
  inflight = 0;
  await sleep(Math.min(30000, 1000 * 2 ** crashCount)); // экспоненциальный backoff
  try {
    await startSession(agentSessionId);
    await persistAgent();
    if (crashCount === 1)
      await currentHandlers?.bot_send?.({ text: "♻️ Агент-сессия перезапущена после ошибки. Продолжаю." }).catch(() => {});
  } finally {
    restarting = false;
  }
}

function onTurnEnd(usage: TurnUsage, sessionId: string | undefined, queueEmpty: boolean): void {
  if (sessionId) agentSessionId = sessionId;
  agentUsage = {
    turns: agentUsage.turns + 1,
    // Полный контекст = новые input + прочитанный кэш + созданный кэш (а НЕ только
    // input_tokens — раньше /context показывал «~14 ток» вместо реальных сотен тысяч).
    contextTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    inputTokens: agentUsage.inputTokens + usage.inputTokens,
    outputTokens: agentUsage.outputTokens + usage.outputTokens,
    cacheReadTokens: agentUsage.cacheReadTokens + usage.cacheReadTokens,
    costUsd: agentUsage.costUsd + usage.costUsd,
    startedAt: agentUsage.startedAt,
  };
  inflight = Math.max(0, inflight - 1);
  void persistAgent();
  if (inflight === 0 && queueEmpty) void applyPending();
}

// События, пришедшие ПОКА запланировано/идёт пересоздание сессии, не теряем:
// буферизуем и переигрываем в НОВУЮ сессию после restart (иначе /new, /compact,
// /effort «съедали» сообщения, пришедшие во время пересоздания).
let pendingBuffer: unknown[] = [];
let applying = false;

async function applyPending(): Promise<void> {
  const mode = resetRequested ? "fresh" : pendingMode;
  if (!mode) return;
  resetRequested = false;
  pendingMode = null;
  applying = true; // продолжаем буферизовать в окне самого restart
  try {
    if (mode === "fresh") {
      await restart(undefined, true);
      log("Сессия агента: новая (контекст очищен).");
    } else {
      await restart(agentSessionId, false);
      log("Сессия агента пересоздана (новые model/effort).");
    }
  } finally {
    applying = false;
  }
  // Переигрываем накопленные за время пересоздания события в новую сессию.
  if (pendingBuffer.length) {
    const buf = pendingBuffer;
    pendingBuffer = [];
    for (const obj of buf) pushEvent(obj);
  }
}

function pushEvent(obj: unknown): void {
  // Пока ждём/идёт пересоздание сессии — копим события, чтобы переиграть после restart.
  if (pendingMode || resetRequested || applying) {
    pendingBuffer.push(obj);
    return;
  }
  inflight++;
  const head = needIntro ? LIVE_INTRO + "\nСОБЫТИЕ:\n" : "Новое событие:\n";
  needIntro = false;
  session.push(head + JSON.stringify(obj, null, 2));
}

async function detect(handlers: Handlers): Promise<void> {
  const [control, monitorsFired, due] = await Promise.all([
    handlers.control_poll!({}).catch(() => null),
    handlers.monitor_poll!({}).catch(() => null),
    handlers.schedule_poll!({}).catch(() => null),
  ]);
  const events: Record<string, unknown> = {};
  const ctrl = (control as { newCommands?: unknown[] } | null)?.newCommands ?? [];
  if (Array.isArray(ctrl) && ctrl.length) events.controlCommands = ctrl;
  // НЕ ставим реакции на сообщения третьих лиц в их личках (это палит автоматизацию
  // и навязчиво). 👀-реакцию ставит только бот в своей личке (см. handleBotMessages).
  if (Array.isArray(monitorsFired) && monitorsFired.length) {
    events.firedMonitors = monitorsFired;
  }
  if (Array.isArray(due) && due.length) events.dueSchedules = due;
  if (Object.keys(events).length) pushEvent(events);
}

// Обрабатывает новые сообщения боту: команды — детерминированно; остальное — событие
// агенту с мгновенным ack (чтобы человек видел, что принято).
async function handleBotMessages(handlers: Handlers, msgs: any[]): Promise<void> {
  for (const m of msgs) {
    await handlers.bot_react!({ chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
    const text = String(m.text).trim();
    const lower = text.toLowerCase();
    if (lower === "/new") {
      pendingMode = "fresh";
      if (inflight === 0) await applyPending();
      await handlers.bot_send!({ text: "✨ Будет новая сессия (контекст очищен; handoff/память сохранены)." }).catch(() => {});
    } else if (lower === "/compact") {
      pushEvent({ command: "compact", instruction: "Кратко законспектируй текущий разговор и состояние в handoff (mem_handoff_set) и важное — в память (mem_note_set). Ничего никому не пиши." });
      pendingMode = "fresh";
      await handlers.bot_send!({ text: "🗜 Сжимаю: сохраню конспект в память и начну новую сессию." }).catch(() => {});
    } else if (lower === "/context") {
      const u = agentUsage;
      await handlers.bot_send!({
        text:
          `📊 Контекст сессии\n` +
          `Сессия: ${agentSessionId ? agentSessionId.slice(0, 8) : "новая"}\n` +
          `Текущий контекст: ~${u.contextTokens.toLocaleString("ru-RU")} ток.\n` +
          `Ходов: ${u.turns} · модель ${currentModel}${currentEffort ? " · effort " + currentEffort : ""}\n` +
          `Всего: ${u.inputTokens} вх / ${u.outputTokens} вых / ${u.cacheReadTokens} кэш · ≈ $${u.costUsd.toFixed(4)}`,
      }).catch(() => {});
    } else if (lower.startsWith("/model")) {
      const v = text.slice(6).trim();
      if (v) {
        currentModel = v;
        session.setModel(v);
        await saveConfig({ model: v });
        await handlers.bot_send!({ text: `🧠 Модель: ${v}` }).catch(() => {});
      } else await handlers.bot_send!({ text: `Текущая модель: ${currentModel}. Использование: /model <opus|sonnet|haiku|…>` }).catch(() => {});
    } else if (lower.startsWith("/effort")) {
      const v = text.slice(7).trim();
      if (v) {
        try {
          currentEffort = normalizeEffort(v);
          await saveConfig({ effort: currentEffort });
          pendingMode = pendingMode ?? "keep";
          if (inflight === 0) await applyPending();
          await handlers.bot_send!({ text: `⚡ Усилие: ${currentEffort} (применю со следующего хода).` }).catch(() => {});
        } catch (e) {
          await handlers.bot_send!({ text: e instanceof Error ? e.message : String(e) }).catch(() => {});
        }
      } else await handlers.bot_send!({ text: `Текущее усилие: ${currentEffort ?? "по умолчанию"}. Использование: /effort <low|medium|high|xhigh|max>` }).catch(() => {});
    } else {
      // мгновенный стилизованный ack (троттлинг), затем — событие агенту
      const now = Date.now();
      if (now - lastProgressAt > PROGRESS_THROTTLE_MS) {
        lastProgressAt = now;
        await handlers.bot_progress!({ text: "принял, разбираю…" }).catch(() => {});
      }
      pushEvent({ botMessages: [m] });
    }
  }
}

async function setup(): Promise<{ handlers: Handlers; lock: LockInfo; tg: Awaited<ReturnType<typeof createClient>> }> {
  await ensureDataLayout();
  const cfg = await requireConfig();
  if (!(await hasSession())) {
    fail("Нет сессии Telegram. Сначала выполните `bun run setup` (или `bun run login`).");
    process.exit(1);
  }
  currentModel = cfg.model;
  currentEffort = cfg.effort;
  engine = cfg.agent;

  // Lock: один сервис — один владелец сессии. Бросит ошибку, если уже запущен.
  const lock = await acquireLock(HUB_PORT);
  hubPort = lock.port;
  hubToken = lock.token;

  const st0 = await loadState();
  agentSessionId = st0.agentSessionId;
  codexThreadId = st0.codexThreadId;
  agentUsage = st0.agentUsage ?? freshUsage();

  const tg = await createClient();
  await tg.connect();

  const handlers = buildHandlers(tg, sessionCtx);
  currentHandlers = handlers;
  return { handlers, lock, tg };
}

// Один проход: bot_poll(0) + детектор; дренаж сессии; выход. Для проверки/cron.
async function runOnce(): Promise<void> {
  const { handlers, tg } = await setup();
  startHubServer(handlers, hubToken, hubPort);
  await startSession(agentSessionId);
  log(`--once: один проход. Движок=${engine}, модель=${currentModel}.`);
  try {
    const r = (await handlers.bot_poll!({ timeout: 0 })) as { configured: boolean; newMessages: any[] };
    if (r.configured && r.newMessages.length) await handleBotMessages(handlers, r.newMessages);
    await detect(handlers);
    // Дренаж: ждём, пока все ходы завершатся (с таймаутом).
    const deadline = Date.now() + 120000;
    while (inflight > 0 && Date.now() < deadline) await sleep(500);
  } finally {
    await session.close();
    await releaseLock();
    tg.destroy().catch(() => {});
  }
}

async function runService(): Promise<void> {
  const { handlers, lock, tg } = await setup();
  const me = await tg.getMe();
  const server = startHubServer(handlers, lock.token, lock.port);
  await startSession(agentSessionId);
  await appendProgress(`service: старт (владелец сессии + RPC-хаб; движок ${engine})`);
  log(`Запущен как ${me.displayName}. Движок=${engine}, модель=${currentModel}${currentEffort ? ", effort=" + currentEffort : ""}. Сессия: ${agentSessionId ? "продолжаю " + agentSessionId.slice(0, 8) : "новая"}.`);

  let stopped = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    log("Останавливаюсь…");
    server.stop(true);
    void session.close();
    tg.destroy().catch(() => {});
    void releaseLock().finally(() => {
      stopped = true;
    });
    // дать releaseLock завершиться
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void stopped;

  // Цикл 1: мгновенный long-poll бота + команды + реакция 👀.
  (async () => {
    while (!stopping) {
      try {
        const r = (await handlers.bot_poll!({ timeout: 20 })) as { configured: boolean; newMessages: any[] };
        if (!r.configured) {
          await sleep(5000);
          continue;
        }
        await handleBotMessages(handlers, r.newMessages);
      } catch (e) {
        log("bot long-poll:", e instanceof Error ? e.message : e);
        await sleep(3000);
      }
    }
  })();

  // Цикл 2: детектор чатов/мониторов/расписаний.
  (async () => {
    while (!stopping) {
      await sleep(DETECT_SECONDS * 1000);
      try {
        await detect(handlers);
      } catch (e) {
        log("детектор:", e instanceof Error ? e.message : e);
      }
    }
  })();

  log(`Готов. Реакция мгновенная (бот) и ~${DETECT_SECONDS}с (чаты/мониторы). Команды бота: /new /compact /context /model /effort. Журнал — здесь и в data/actions.log.`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) await runOnce();
  else await runService();
}

main().catch(async (err) => {
  fail("Фатальная ошибка сервиса:", err instanceof Error ? err.message : err);
  await releaseLock().catch(() => {});
  process.exit(1);
});
