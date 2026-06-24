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
import { registerBotCommands } from "./lib/bot.ts";
import { checkForUpdate, applyUpdate, currentVersion } from "./lib/update.ts";
import { managedBy } from "./lib/service-install.ts";
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LIVE_INTRO = `Ты — живая сессия агента личного Telegram. Тебе НА ЛЕТУ приходят события (новые
сообщения, команды, сработавшие мониторы/расписания) — реагируй по правилам и памяти.

‼️ КАК ТЫ ОБЩАЕШЬСЯ С ЧЕЛОВЕКОМ В TELEGRAM:
Весь твой ТЕКСТОВЫЙ вывод автоматически отправляется человеку как сообщение бота в
Telegram (формат Telegram MarkdownV2). Поэтому НЕ нужно звать bot_send, чтобы ответить —
просто напиши ответ текстом, и он уйдёт человеку. Пиши по-человечески и на ЯЗЫКЕ
человека (обычно по-русски) только то, что адресовано ему — без служебных мета-
заметок («owner checks…», «msgId 54»). Внутренние рассуждения держи в thinking, не в
тексте. Форматируй MarkdownV2 (*жирный*, _курсив_, \`код\`); спецсимволы _*[]()~\`>#+-=|{}.!
экранируй обратным слешем (если ошибёшься — отправится обычным текстом). bot_send нужен
ТОЛЬКО чтобы написать в КОНКРЕТНЫЙ chat_id (не тому, кто сейчас пишет) или проактивно по
расписанию; для обычного ответа bot_send НЕ вызывай (будет дубль). Пока ты работаешь,
человеку сам показывается индикатор «печатает…».

Мониторы — по их action (на монитор один ответ на пачку, если правило не велит иначе).
👀-реакцию ставит только БОТ в своей личке (что принял твоё сообщение) — сервис делает
это сам; на сообщения других людей реакции НЕ ставь. НЕ отмечай прочитанным. По
умолчанию пассивен. Отправка в чужие чаты разрешена кодом только при явном разрешении
(монитор reply / permission_grant). Значимое — в handoff/progress. Следи за контекстом
(session_status); если переполняется — актуализируй handoff/память и session_reset.\n`;

let stopping = false;
let restarting = false;
let inflight = 0; // сколько ходов в очереди/в работе
let needIntro = true;

// Текст агента = сообщение бота человеку. ВСЁ, что модель выводит текстом, отправляется
// человеку в Telegram напрямую (как обычное сообщение бота, MarkdownV2 с фолбэком,
// длинное режется). Поэтому отдельный bot_send для ответа не нужен. Шлём в чат текущего
// разговора (lastBotChatId; по умолчанию — владелец). Сериализуем, чтобы шли по порядку.
let forwardGate: Promise<unknown> = Promise.resolve();
function forwardAgentText(text: string): void {
  const t = text.trim();
  if (!t) return;
  const chatId = lastBotChatId;
  forwardGate = forwardGate.then(() => currentHandlers?.bot_send?.({ text: t, chat_id: chatId }).catch(() => {}));
}

// Чат бота, по которому сейчас идёт работа (куда показывать «печатает…»). По умолчанию
// — личка владельца (botSend/botTyping подставят её сами при undefined).
let lastBotChatId: number | undefined;

// Само-перезапуск: имеет смысл только под менеджером (systemd/launchd), который поднимет
// процесс заново после выхода. Иначе (foreground) — просим перезапустить вручную.
async function restartSelf(reason: string): Promise<boolean> {
  if (!managedBy()) return false;
  log(`Само-перезапуск (${reason})…`);
  stopping = true;
  try {
    await session?.close();
  } catch {
    /* ignore */
  }
  await releaseLock().catch(() => {});
  setTimeout(() => process.exit(0), 300); // менеджер поднимет заново (Restart=always/KeepAlive)
  return true;
}

// Кого уже уведомили, что он постучался боту, но не в allowlist (без спама).
const notifiedUnknown = new Set<number>();
async function notifyUnauthorized(handlers: Handlers, list: { fromId: number; fromUsername: string | null }[]): Promise<void> {
  for (const u of list) {
    if (notifiedUnknown.has(u.fromId)) continue;
    notifiedUnknown.add(u.fromId);
    const who = u.fromUsername ? `@${u.fromUsername}` : `id ${u.fromId}`;
    await handlers
      .bot_send!({ text: `🔔 ${who} (id ${u.fromId}) написал боту, но он не в списке разрешённых.\nРазрешить ему писать: /allowuser ${u.fromId}` })
      .catch(() => {});
  }
}

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
    onText: forwardAgentText,
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

// Текст /help и /start: что бот умеет + как пользоваться + команды.
function helpText(isOwner: boolean): string {
  const intro =
    `🤖 Я — ИИ-агент твоего личного Telegram. Этот бот — канал управления мной.\n` +
    `Пиши обычным текстом — я прочитаю чаты, пойму контекст (включая фото) и отвечу/выполню.\n`;
  const can =
    `\nЧто умею:\n` +
    `• Следить за конкретным чатом/человеком/топиком и реагировать по твоим правилам (мониторы).\n` +
    `• Присылать периодические сводки (расписания), напр. «каждые 5 минут — новые сообщения».\n` +
    `• Отвечать от твоего имени — но ТОЛЬКО там, где ты явно разрешил.\n` +
    `• Смотреть фото/картинки, типы и метаданные медиа, группы, каналы, топики.\n` +
    `• По умолчанию я ПАССИВЕН: без твоих правил ничего в чатах не делаю.\n`;
  const how =
    `\nКак просить (примеры обычным текстом):\n` +
    `• «следи за чатом с мамой, напомни, если не отвечу 15 минут»\n` +
    `• «каждые 5 минут присылай сводку новых сообщений»\n` +
    `• «отвечай Алексею короткой цитатой на каждое его сообщение»\n`;
  if (!isOwner) {
    return intro + `\nПиши обычным текстом — я отвечу. Полный набор команд доступен владельцу бота.`;
  }
  const cmds =
    `\nКоманды:\n` +
    `/help, /start — эта справка\n` +
    `/context — контекст и расход текущей сессии\n` +
    `/new — новая сессия (очистить контекст)\n` +
    `/compact — сжать контекст в память и начать новую сессию\n` +
    `/model <opus|sonnet|…> — сменить модель\n` +
    `/effort <low|medium|high|xhigh|max> — уровень усилия\n` +
    `/monitors — активные мониторы\n` +
    `/schedules — расписания\n` +
    `/permissions — кому я могу писать\n` +
    `/grant <chat> — разрешить мне писать в чат (id или @username)\n` +
    `/revoke <chat> — отозвать разрешение\n` +
    `/users — кто может писать боту\n` +
    `/allowuser <id|@user> — разрешить писать боту\n` +
    `/denyuser <id|@user> — запретить писать боту\n` +
    `/version — версия и проверка обновлений\n` +
    `/update — обновить tg до последней версии\n` +
    `/restart — перезапустить агента (если запущен сервисом)`;
  return intro + can + how + cmds;
}

function fmtMonitors(list: any[]): string {
  if (!list?.length) return "Мониторов нет. Попроси: «следи за …».";
  return (
    "👁 Мониторы:\n" +
    list
      .map((m) => `${m.enabled ? "🟢" : "⚪️"} ${m.id} ${m.name} · ${m.action} · чат ${m.chat}${m.onlyIfOwnerSilentSec ? ` · если молчишь ${m.onlyIfOwnerSilentSec}с` : ""}`)
      .join("\n")
  );
}
function fmtSchedules(list: any[]): string {
  if (!list?.length) return "Расписаний нет. Попроси: «каждые N минут …».";
  return "⏰ Расписания:\n" + list.map((s) => `${s.enabled ? "🟢" : "⚪️"} ${s.id} ${s.name} · каждые ${s.everySec}с → ${s.deliver}`).join("\n");
}
function fmtPermissions(perms: Record<string, any>): string {
  const ids = Object.keys(perms ?? {});
  if (!ids.length) return 'Явных разрешений нет. Себе («me») и в управляющий канал — пишу всегда.';
  return "✅ Могу писать:\n" + ids.map((id) => `${id} ${perms[id].label ?? ""} · ${perms[id].source ?? ""}`).join("\n");
}
function fmtBotUsers(list: any[]): string {
  if (!list?.length) return "Боту может писать только владелец. Добавить: /allowuser <id|@user>.";
  return "👥 Могут писать боту (помимо владельца):\n" + list.map((u) => `${u.id}${u.username ? ` @${u.username}` : ""}${u.note ? ` · ${u.note}` : ""}`).join("\n");
}

// Обрабатывает новые сообщения боту: команды — детерминированно (владельцу);
// остальное — событие агенту с мгновенным ack. Ответы шлём В ТОТ ЖЕ чат (chat_id),
// чтобы разрешённые не-владельцы получали ответ себе.
async function handleBotMessages(handlers: Handlers, msgs: any[]): Promise<void> {
  for (const m of msgs) {
    await handlers.bot_react!({ chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
    const text = String(m.text).trim();
    const lower = text.toLowerCase();
    const isOwner = m.isOwner !== false; // back-compat: undefined → владелец
    const to = m.chatId as number;
    const reply = (t: string) => handlers.bot_send!({ text: t, chat_id: to }).catch(() => {});
    const arg = text.replace(/^\/\S+\s*/, "").trim();
    const isCmd = lower.startsWith("/");

    // /help и /start — всем разрешённым.
    if (lower === "/help" || lower === "/start") {
      await reply(helpText(isOwner));
      continue;
    }
    // Остальные команды — только владельцу.
    if (isCmd && !isOwner) {
      await reply("Эта команда доступна только владельцу бота. Просто напиши, что нужно — я отвечу.");
      continue;
    }

    if (lower === "/new") {
      pendingMode = "fresh";
      if (inflight === 0) await applyPending();
      await reply("✨ Будет новая сессия (контекст очищен; handoff/память сохранены).");
    } else if (lower === "/compact") {
      pushEvent({ command: "compact", instruction: "Кратко законспектируй текущий разговор и состояние в handoff (mem_handoff_set) и важное — в память (mem_note_set). Ничего никому не пиши." });
      pendingMode = "fresh";
      await reply("🗜 Сжимаю: сохраню конспект в память и начну новую сессию.");
    } else if (lower === "/context") {
      const u = agentUsage;
      await reply(
        `📊 Контекст сессии\n` +
          `Сессия: ${agentSessionId ? agentSessionId.slice(0, 8) : "новая"}\n` +
          `Текущий контекст: ~${u.contextTokens.toLocaleString("ru-RU")} ток.\n` +
          `Ходов: ${u.turns} · модель ${currentModel}${currentEffort ? " · effort " + currentEffort : ""}\n` +
          `Всего: ${u.inputTokens} вх / ${u.outputTokens} вых / ${u.cacheReadTokens} кэш · ≈ $${u.costUsd.toFixed(4)}`,
      );
    } else if (lower.startsWith("/model")) {
      if (arg) {
        currentModel = arg;
        session.setModel(arg);
        await saveConfig({ model: arg });
        await reply(`🧠 Модель: ${arg}`);
      } else await reply(`Текущая модель: ${currentModel}. Использование: /model <opus|sonnet|haiku|…>`);
    } else if (lower.startsWith("/effort")) {
      if (arg) {
        try {
          currentEffort = normalizeEffort(arg, engine);
          await saveConfig({ effort: currentEffort });
          pendingMode = pendingMode ?? "keep";
          if (inflight === 0) await applyPending();
          await reply(`⚡ Усилие: ${currentEffort} (применю со следующего хода).`);
        } catch (e) {
          await reply(e instanceof Error ? e.message : String(e));
        }
      } else await reply(`Текущее усилие: ${currentEffort ?? "по умолчанию"} (движок ${engine}).`);
    } else if (lower === "/version") {
      const cur = await currentVersion();
      await reply(`📦 Версия tg: ${cur}. Проверяю обновления…`);
      const ch = await checkForUpdate();
      if (!ch.ok) await reply(`Не смог проверить обновления: ${ch.error}`);
      else if (ch.hasUpdate)
        await reply(`🆕 Доступна версия ${ch.latest} (у тебя ${ch.current}).${ch.notes ? `\n\nИзменения:\n${ch.notes}` : ""}\n\nОбновить: /update`);
      else await reply(`✅ Установлена последняя версия (${ch.current}).`);
    } else if (lower === "/update") {
      await reply("⏳ Обновляюсь (git pull + bun install)…");
      const r = await applyUpdate();
      if (!r.ok) {
        await reply(`❌ Не удалось обновиться: ${r.error}`);
      } else {
        const restarting = await restartSelf("после /update");
        await reply(`✅ Обновлено до ${r.version}. ${restarting ? "Перезапускаюсь, чтобы применить…" : "Перезапусти сервис вручную, чтобы применить: bun run service"}`);
      }
    } else if (lower === "/restart") {
      const ok = await restartSelf("по команде /restart");
      if (ok) await reply("♻️ Перезапускаюсь…");
      else await reply("Я запущен не как сервис (foreground) — перезапусти вручную: останови (Ctrl+C) и `bun run service`. Либо поставь сервис: `bun run tg install-service`.");
    } else if (lower === "/monitors") {
      await reply(fmtMonitors((await handlers.monitor_list!({}).catch(() => [])) as any[]));
    } else if (lower === "/schedules") {
      await reply(fmtSchedules((await handlers.schedule_list!({}).catch(() => [])) as any[]));
    } else if (lower === "/permissions") {
      await reply(fmtPermissions((await handlers.permission_list!({}).catch(() => ({}))) as Record<string, any>));
    } else if (lower === "/users") {
      await reply(fmtBotUsers((await handlers.bot_users_list!({}).catch(() => [])) as any[]));
    } else if (lower.startsWith("/allowuser")) {
      if (!arg) await reply("Использование: /allowuser <id|@username>");
      else {
        try {
          const u = (await handlers.bot_user_allow!({ user: arg })) as { id: number };
          notifiedUnknown.delete(u.id);
          await reply(`✅ Теперь боту может писать: ${arg} (id ${u.id}).`);
        } catch (e) {
          await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (lower.startsWith("/denyuser")) {
      if (!arg) await reply("Использование: /denyuser <id|@username>");
      else {
        try {
          const r = (await handlers.bot_user_deny!({ user: arg })) as { removed: boolean };
          await reply(r.removed ? `🚫 Больше не может писать боту: ${arg}.` : `Не найден в списке: ${arg}.`);
        } catch (e) {
          await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (lower.startsWith("/grant")) {
      if (!arg) await reply("Использование: /grant <id|@username> — разрешить мне писать в этот чат.");
      else {
        try {
          await handlers.permission_grant!({ chat: arg, source: "bot:/grant" });
          await reply(`✅ Разрешил себе писать в чат ${arg}.`);
        } catch (e) {
          await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (lower.startsWith("/revoke")) {
      if (!arg) await reply("Использование: /revoke <id|@username>");
      else {
        try {
          const r = (await handlers.permission_revoke!({ chat: arg })) as { revoked: boolean };
          await reply(r.revoked ? `🚫 Отозвал разрешение писать в ${arg}.` : `Разрешения на ${arg} не было.`);
        } catch (e) {
          await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (isCmd) {
      await reply("Неизвестная команда. /help — список команд.");
    } else {
      // обычный текст → событие агенту. Ответ агента уйдёт человеку его текстом
      // автоматически (forwardAgentText), отдельный ack не нужен. Сразу показываем
      // «печатает…», чтобы было видно, что бот взялся за работу.
      lastBotChatId = to;
      await handlers.bot_typing!({ chat_id: to }).catch(() => {});
      pushEvent({ botMessages: [m], replyTo: { chatId: to, isOwner } });
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
// ВАЖНО: останавливаем RPC-сервер в finally, иначе Bun.serve держит процесс живым и
// `service --once` никогда не завершится (тогда это не cron, а зависший демон).
async function runOnce(): Promise<void> {
  const { handlers, tg } = await setup();
  const server = startHubServer(handlers, hubToken, hubPort);
  await startSession(agentSessionId);
  log(`--once: один проход. Движок=${engine}, модель=${currentModel}.`);
  try {
    const r = (await handlers.bot_poll!({ timeout: 0 })) as { configured: boolean; newMessages: any[]; unauthorized?: any[] };
    if (r.configured && r.newMessages.length) await handleBotMessages(handlers, r.newMessages);
    if (r.configured && r.unauthorized?.length) await notifyUnauthorized(handlers, r.unauthorized);
    await detect(handlers);
    // Дренаж: ждём, пока все ходы завершатся (с таймаутом).
    const deadline = Date.now() + 120000;
    while (inflight > 0 && Date.now() < deadline) await sleep(500);
  } finally {
    server.stop(true);
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
  await registerBotCommands().catch(() => {}); // подсказки команд бота (/help и пр.)
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
        const r = (await handlers.bot_poll!({ timeout: 20 })) as {
          configured: boolean;
          newMessages: any[];
          unauthorized?: { fromId: number; fromUsername: string | null }[];
        };
        if (!r.configured) {
          await sleep(5000);
          continue;
        }
        await handleBotMessages(handlers, r.newMessages);
        if (r.unauthorized?.length) await notifyUnauthorized(handlers, r.unauthorized);
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

  // Цикл 3: индикатор «печатает…» в чате бота, пока агент реально работает (inflight>0).
  // Telegram держит typing ~5с, поэтому переотправляем каждые ~4с. Как только ходов нет
  // (агент ответил ИЛИ упал — watchdog обнуляет inflight) — перестаём, и статус гаснет.
  (async () => {
    while (!stopping) {
      if (inflight > 0) await handlers.bot_typing!({ chat_id: lastBotChatId }).catch(() => {});
      await sleep(4000);
    }
  })();

  // Цикл 4: периодическая проверка новой версии; при появлении — уведомить владельца
  // ОДИН раз (предложить /update). Интервал TG_UPDATE_CHECK_HOURS (по умолчанию 24ч).
  const updateCheckMs = Math.max(1, Number(process.env.TG_UPDATE_CHECK_HOURS ?? 24)) * 3600 * 1000;
  (async () => {
    await sleep(30000); // не на самом старте
    while (!stopping) {
      try {
        const ch = await checkForUpdate();
        if (ch.ok && ch.hasUpdate && ch.latest) {
          const st = await loadState();
          if (st.notifiedUpdateVersion !== ch.latest) {
            await handlers
              .bot_send!({ text: `🆕 Доступна новая версия tg: ${ch.latest} (у тебя ${ch.current}).${ch.notes ? `\n\nИзменения:\n${ch.notes}` : ""}\n\nОбновить: /update` })
              .catch(() => {});
            await updateState((s) => {
              s.notifiedUpdateVersion = ch.latest;
            });
          }
        }
      } catch (e) {
        log("проверка обновлений:", e instanceof Error ? e.message : e);
      }
      await sleep(updateCheckMs);
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
