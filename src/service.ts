// Сервис — ЕДИНСТВЕННЫЙ процесс, который работает с Telegram. МУЛЬТИТЕНАНТНЫЙ: в одном
// процессе поднимается несколько независимых пользователей («тенантов»), у каждого своя
// рабочая папка (tenants/<имя>) со своей сессией, ботом, памятью, агентом и RPC-хабом.
// Изоляция — через контекст тенанта (AsyncLocalStorage): весь код тенанта исполняется в
// tenantStore.run(ctx, …), и все пути/лок/состояние указывают на ЕГО папку.
//
// На каждого тенанта: long-poll бота, детектор чатов/мониторов/расписаний (~3с), одна
// непрерывная сессия агента (streaming, переживает рестарт и падения через watchdog),
// индикатор «печатает…», авто-доставка текста агента в Telegram, периодическая проверка
// обновлений. Команды бота: /help /start /new /compact /context /model /effort /monitors
// /schedules /users /allowuser /denyuser /here /version /update /restart.
//
// Флаг --once: один проход по каждому тенанту и выход (для проверки/cron).

import { requireConfig, saveConfig, normalizeEffort } from "./lib/config.ts";
import { registerBotCommands } from "./lib/bot.ts";
import { checkForUpdate, applyUpdate, currentVersion } from "./lib/update.ts";
import { managedBy } from "./lib/service-install.ts";
import { createClient, hasSession } from "./telegram/client.ts";
import { ensureDataLayout, appendProgress } from "./lib/memory.ts";
import { loadState, updateState, type AgentUsage } from "./lib/state.ts";
import { prepareLock, writeLock, releaseLock } from "./lib/lock.ts";
import { buildHandlers, startHubServer, type Handlers, type AgentSessionCtx } from "./hub.ts";
import { buildSystemAppend } from "./agent/prompt.ts";
import { createAgentSession, type AgentSession, type TurnUsage } from "./agent/session.ts";
import { log, fail } from "./lib/log.ts";
import { type TenantContext } from "./lib/paths.ts";
import { autoMigrateLegacy, listTenants, tenantContext, withTenant } from "./lib/tenants.ts";

const DETECT_SECONDS = Number(process.env.TG_DETECT_SECONDS ?? 3);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LIVE_INTRO = `Ты — живая сессия агента личного Telegram. Тебе НА ЛЕТУ приходят события (новые
сообщения, команды, сработавшие мониторы/расписания) — реагируй по правилам и памяти.

‼️ КАК ТЫ ОБЩАЕШЬСЯ С ЧЕЛОВЕКОМ В TELEGRAM:
Весь твой ТЕКСТОВЫЙ вывод автоматически отправляется человеку как сообщение бота в
Telegram. Поэтому НЕ нужно звать bot_send, чтобы ответить — просто напиши ответ текстом,
и он уйдёт человеку. Пиши по-человечески и на ЯЗЫКЕ человека (обычно по-русски) только
то, что адресовано ему — без служебных мета-заметок («owner checks…», «msgId 54»).
Внутренние рассуждения держи в thinking, не в тексте. Форматируй ОБЫЧНЫМ Markdown
(**жирный**, *курсив*, \`код\`, \`\`\`блоки кода\`\`\`, [текст](url)) — сервис сам конвертирует
его в Telegram-разметку и экранирует спецсимволы; НИЧЕГО экранировать вручную НЕ нужно.
bot_send нужен ТОЛЬКО чтобы написать в КОНКРЕТНЫЙ chat_id (не тому, кто сейчас пишет) или
проактивно по расписанию; для обычного ответа bot_send НЕ вызывай (будет дубль). Пока ты
работаешь, человеку сам показывается индикатор «печатает…».

Мониторы — по их action (на монитор один ответ на пачку, если правило не велит иначе).
👀-реакцию ставит только БОТ в своей личке (что принял твоё сообщение) — сервис делает
это сам; на сообщения других людей реакции НЕ ставь. НЕ отмечай прочитанным. По
умолчанию пассивен: отправка технически свободна (писать можно в любой чат), но в
чужие чаты пиши ТОЛЬКО по явной просьбе человека или по его правилу (монитор reply).
Значимое — в handoff/progress. Следи за контекстом
(session_status); если переполняется — актуализируй handoff/память и session_reset.\n`;

function freshUsage(): AgentUsage {
  return { turns: 0, contextTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, startedAt: new Date().toISOString() };
}

// Порт хаба подбираем ДИНАМИЧЕСКИ (предпочитаем preferred, иначе любой свободный), чтобы
// не конфликтовать с другими приложениями на машине. Фактический порт пишется в lock
// тенанта — MCP-прокси берёт его оттуда. Так сервис стабилен сам по себе.
function portAvailable(p: number): boolean {
  try {
    const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}
function pickPort(preferred: number): number {
  if (portAvailable(preferred)) return preferred;
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  if (typeof p !== "number" || p <= 0) throw new Error("не удалось выделить свободный порт для хаба");
  return p;
}

// ---------- общие, не зависящие от тенанта помощники форматирования ----------

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
    `/users — кто может писать боту\n` +
    `/allowuser <id|@user> — разрешить писать боту\n` +
    `/denyuser <id|@user> — запретить писать боту\n` +
    `/here — (в группе) сделать её общей: отвечаю всем разрешённым; /forgethere — отключить\n` +
    `/version — версия и проверка обновлений\n` +
    `/update — обновить tg до последней версии\n` +
    `/restart — перезапустить сервис`;
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
function fmtBotUsers(list: any[]): string {
  if (!list?.length) return "Боту может писать только владелец. Добавить: /allowuser <id|@user>.";
  return "👥 Могут писать боту (помимо владельца):\n" + list.map((u) => `${u.id}${u.username ? ` @${u.username}` : ""}${u.note ? ` · ${u.note}` : ""}`).join("\n");
}

// ---------- глобальное управление процессом (общее для всех тенантов) ----------

let globalStopping = false;
const allRuntimes: TenantRuntime[] = [];

/** Перезапуск ВСЕГО процесса (все тенанты) — имеет смысл только под менеджером
 *  (systemd/launchd), который поднимет процесс заново. Иначе просим вручную. */
async function restartProcess(reason: string): Promise<boolean> {
  if (!managedBy()) return false;
  log(`Перезапуск процесса (${reason})…`);
  globalStopping = true;
  await Promise.all(allRuntimes.map((r) => r.stop().catch(() => {})));
  setTimeout(() => process.exit(0), 300);
  return true;
}

// ---------- рантайм одного тенанта ----------

interface TenantRuntime {
  ctx: TenantContext;
  startService(): Promise<void>;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

function createTenantRuntime(ctx: TenantContext): TenantRuntime {
  const tag = ctx.name; // префикс в логах
  const lg = (...a: unknown[]) => log(`[${tag}]`, ...a);

  let stopping = false;
  let restarting = false;
  let inflight = 0;
  let needIntro = true;

  let handlers: Handlers | undefined;
  let server: ReturnType<typeof startHubServer> | undefined;
  let tg: Awaited<ReturnType<typeof createClient>> | undefined;
  let hubToken = "";
  let hubPort = ctx.hubPort; // фактический порт (подбирается в init, если preferred занят)

  let currentModel = "opus";
  let currentEffort: string | undefined;
  let engine: "claude" | "codex" = "claude";
  let botUsername: string | undefined; // для отсева команд, адресованных другому боту

  let agentSessionId: string | undefined;
  let codexThreadId: string | undefined;
  let agentUsage: AgentUsage = freshUsage();
  let session: AgentSession | undefined;

  let pendingMode: "fresh" | "keep" | null = null;
  let resetRequested = false;
  // Буфер событий на время пересоздания/рестарта сессии (с целью ответа).
  let pendingBuffer: { obj: unknown; target: number | undefined }[] = [];
  let applying = false;

  // FIFO целей ответа: на каждое запушенное событие — чат, КУДА уйдёт текст этого хода.
  // forwardAgentText шлёт в голову очереди (текущий ход), onTurnEnd её сдвигает. Так
  // ответ не «утечёт» в чужой чат при чередовании сообщений из разных чатов/групп.
  let replyTargets: (number | undefined)[] = [];
  const currentTarget = (): number | undefined => replyTargets[0];
  let forwardGate: Promise<unknown> = Promise.resolve();
  const notifiedUnknown = new Set<number>();

  let crashCount = 0;
  let lastCrashTs = 0;
  let crashStopped = false;

  const sessionCtx: AgentSessionCtx = {
    getSessionId: () => agentSessionId,
    getUsage: () => agentUsage,
    requestReset: () => {
      resetRequested = true;
    },
  };

  // Текст агента → человеку (как сообщение бота; Markdown→HTML и нарезку делает botSend). Серия.
  // Цель — голова FIFO (чат текущего хода); для событий без адресата (мониторы) — owner.
  function forwardAgentText(text: string): void {
    const t = text.trim();
    if (!t) return;
    const chatId = currentTarget();
    forwardGate = forwardGate.then(() => handlers?.bot_send?.({ text: t, chat_id: chatId }).catch(() => {}));
  }

  async function notifyUnauthorized(list: { fromId: number; fromUsername: string | null }[]): Promise<void> {
    for (const u of list) {
      if (notifiedUnknown.has(u.fromId)) continue;
      notifiedUnknown.add(u.fromId);
      const who = u.fromUsername ? `@${u.fromUsername}` : `id ${u.fromId}`;
      await handlers?.bot_send?.({ text: `🔔 ${who} (id ${u.fromId}) написал боту, но он не в списке разрешённых.\nРазрешить: /allowuser ${u.fromId}` }).catch(() => {});
    }
  }

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
    await session?.close();
    if (fresh) {
      agentUsage = freshUsage();
      codexThreadId = undefined;
    }
    await startSession(resume);
    await persistAgent();
  }

  async function onSessionError(err: unknown): Promise<void> {
    if (stopping || globalStopping || restarting || crashStopped) return;
    restarting = true;
    const now = Date.now();
    if (now - lastCrashTs > 60000) crashCount = 0;
    lastCrashTs = now;
    crashCount++;
    inflight = 0; // ход не завершится — сбрасываем (иначе typing «долбит» вечно)
    replyTargets = []; // цели мёртвых ходов сняты (выравнивание с inflight)
    lg("watchdog: сессия агента упала:", err instanceof Error ? err.message : err);
    if (crashCount > 5) {
      crashStopped = true;
      restarting = false;
      lg("watchdog: 5 падений подряд — останавливаю перезапуск. Проверьте модель/окружение.");
      await handlers?.bot_send?.({ text: "⛔ Агент-сессия падает повторно. Перезапуск остановлен — проверь /model и логи." }).catch(() => {});
      return;
    }
    await sleep(Math.min(30000, 1000 * 2 ** crashCount));
    try {
      await startSession(agentSessionId);
      await persistAgent();
      if (crashCount === 1) await handlers?.bot_send?.({ text: "♻️ Агент-сессия перезапущена после ошибки. Продолжаю." }).catch(() => {});
    } finally {
      restarting = false;
    }
    // События, пришедшие в окно backoff, копились в буфере — переигрываем в новую сессию.
    replayBuffer();
  }

  function onTurnEnd(usage: TurnUsage, sessionId: string | undefined, queueEmpty: boolean): void {
    if (sessionId) agentSessionId = sessionId;
    agentUsage = {
      turns: agentUsage.turns + 1,
      contextTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      inputTokens: agentUsage.inputTokens + usage.inputTokens,
      outputTokens: agentUsage.outputTokens + usage.outputTokens,
      cacheReadTokens: agentUsage.cacheReadTokens + usage.cacheReadTokens,
      costUsd: agentUsage.costUsd + usage.costUsd,
      startedAt: agentUsage.startedAt,
    };
    inflight = Math.max(0, inflight - 1);
    replyTargets.shift(); // ход завершён — снимаем его цель ответа
    void persistAgent();
    if (inflight === 0 && queueEmpty) void applyPending();
  }

  async function applyPending(): Promise<void> {
    const mode = resetRequested ? "fresh" : pendingMode;
    if (!mode) return;
    resetRequested = false;
    pendingMode = null;
    applying = true;
    try {
      if (mode === "fresh") {
        await restart(undefined, true);
        lg("Сессия агента: новая (контекст очищен).");
      } else {
        await restart(agentSessionId, false);
        lg("Сессия агента пересоздана (новые model/effort).");
      }
    } finally {
      applying = false;
    }
    replayBuffer();
  }

  function replayBuffer(): void {
    if (!pendingBuffer.length) return;
    const buf = pendingBuffer;
    pendingBuffer = [];
    for (const e of buf) pushEvent(e.obj, e.target);
  }

  function pushEvent(obj: unknown, target?: number): void {
    // Пока сессия пересоздаётся/рестартится (watchdog) — копим события (с целью ответа),
    // чтобы не пушить в мёртвую очередь и не терять их. crashStopped — сессия мертва.
    if (crashStopped) {
      lg("событие пропущено: агент-сессия остановлена (см. логи)");
      return;
    }
    if (pendingMode || resetRequested || applying || restarting) {
      pendingBuffer.push({ obj, target });
      return;
    }
    inflight++;
    replyTargets.push(target);
    const head = needIntro ? LIVE_INTRO + "\nСОБЫТИЕ:\n" : "Новое событие:\n";
    needIntro = false;
    session!.push(head + JSON.stringify(obj, null, 2));
  }

  async function detect(): Promise<void> {
    const h = handlers!;
    const [control, monitorsFired, due] = await Promise.all([
      h.control_poll!({}).catch(() => null),
      h.monitor_poll!({}).catch(() => null),
      h.schedule_poll!({}).catch(() => null),
    ]);
    const events: Record<string, unknown> = {};
    const ctrl = (control as { newCommands?: unknown[] } | null)?.newCommands ?? [];
    if (Array.isArray(ctrl) && ctrl.length) events.controlCommands = ctrl;
    if (Array.isArray(monitorsFired) && monitorsFired.length) events.firedMonitors = monitorsFired;
    if (Array.isArray(due) && due.length) events.dueSchedules = due;
    if (Object.keys(events).length) pushEvent(events);
  }

  async function handleBotMessages(msgs: any[]): Promise<void> {
    const h = handlers!;
    for (const m of msgs) {
      await h.bot_react!({ chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
      const text = String(m.text).trim();
      const lower = text.toLowerCase();
      const isOwner = m.isOwner !== false;
      const to = m.chatId as number;
      const reply = (t: string) => h.bot_send!({ text: t, chat_id: to }).catch(() => {});
      const arg = text.replace(/^\/\S+\s*/, "").trim();
      const isCmd = lower.startsWith("/");
      // В группах команда приходит как «/cmd@botusername [args]».
      const token0 = lower.split(/\s+/)[0]!;
      const atIdx = token0.indexOf("@");
      const cmd = atIdx >= 0 ? token0.slice(0, atIdx) : token0;
      const cmdSuffix = atIdx >= 0 ? token0.slice(atIdx + 1) : "";
      // Команда явно адресована ДРУГОМУ боту (/cmd@OtherBot) — не наша, игнорируем.
      if (isCmd && cmdSuffix && botUsername && cmdSuffix !== botUsername.toLowerCase()) continue;

      if (cmd === "/help" || cmd === "/start") {
        await reply(helpText(isOwner));
        continue;
      }
      if (isCmd && !isOwner) {
        await reply("Эта команда доступна только владельцу бота. Просто напиши, что нужно — я отвечу.");
        continue;
      }

      if (cmd === "/new") {
        pendingMode = "fresh";
        if (inflight === 0) await applyPending();
        await reply("✨ Будет новая сессия (контекст очищен; handoff/память сохранены).");
      } else if (cmd === "/compact") {
        pushEvent({ command: "compact", instruction: "Кратко законспектируй текущий разговор и состояние в handoff (mem_handoff_set) и важное — в память (mem_note_set). Ничего никому не пиши." });
        pendingMode = "fresh";
        await reply("🗜 Сжимаю: сохраню конспект в память и начну новую сессию.");
      } else if (cmd === "/context") {
        const u = agentUsage;
        await reply(
          `📊 Контекст сессии\n` +
            `Сессия: ${agentSessionId ? agentSessionId.slice(0, 8) : "новая"}\n` +
            `Текущий контекст: ~${u.contextTokens.toLocaleString("ru-RU")} ток.\n` +
            `Ходов: ${u.turns} · модель ${currentModel}${currentEffort ? " · effort " + currentEffort : ""}\n` +
            `Всего: ${u.inputTokens} вх / ${u.outputTokens} вых / ${u.cacheReadTokens} кэш · ≈ $${u.costUsd.toFixed(4)}`,
        );
      } else if (cmd === "/model") {
        if (arg) {
          currentModel = arg;
          await saveConfig({ model: arg });
          if (engine === "codex") {
            // У Codex смена модели на лету не поддерживается — пересоздаём сессию.
            pendingMode = pendingMode ?? "keep";
            if (inflight === 0) await applyPending();
            await reply(`🧠 Модель: ${arg} (применю со следующего хода).`);
          } else {
            session?.setModel(arg); // Claude — на лету
            await reply(`🧠 Модель: ${arg}`);
          }
        } else await reply(`Текущая модель: ${currentModel}. Использование: /model <opus|sonnet|haiku|…>`);
      } else if (cmd === "/effort") {
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
      } else if (cmd === "/version") {
        const cur = await currentVersion();
        await reply(`📦 Версия tg: ${cur}. Проверяю обновления…`);
        const ch = await checkForUpdate();
        if (!ch.ok) await reply(`Не смог проверить обновления: ${ch.error}`);
        else if (ch.hasUpdate) await reply(`🆕 Доступна версия ${ch.latest} (у тебя ${ch.current}).${ch.notes ? `\n\nИзменения:\n${ch.notes}` : ""}\n\nОбновить: /update`);
        else await reply(`✅ Установлена последняя версия (${ch.current}).`);
      } else if (cmd === "/update") {
        await reply("⏳ Обновляюсь (git pull + bun install)…");
        const r = await applyUpdate();
        if (!r.ok) await reply(`❌ Не удалось обновиться: ${r.error}`);
        else {
          const restarting2 = await restartProcess("после /update");
          await reply(`✅ Обновлено до ${r.version}. ${restarting2 ? "Перезапускаю сервис…" : "Перезапусти сервис вручную, чтобы применить: bun run service"}`);
        }
      } else if (cmd === "/restart") {
        const ok = await restartProcess("по команде /restart");
        if (ok) await reply("♻️ Перезапускаю сервис…");
        else await reply("Я запущен не как сервис (foreground) — перезапусти вручную (Ctrl+C + `bun run service`) или поставь сервис: `bun run tg install-service`.");
      } else if (cmd === "/here") {
        if (m.chatType === "private") {
          await reply("Команда /here — для группы. Добавь меня в общую (например, семейную) группу и отправь там /here — я начну отвечать всем разрешённым участникам.");
        } else {
          await saveConfig({ botGroupChatId: to });
          await reply(
            "✅ Готово: это теперь наша общая группа — я отвечаю здесь всем разрешённым участникам.\n" +
              "⚠️ Важно: чтобы я видел ОБЫЧНЫЕ сообщения (не только команды), выключи мой privacy-mode у @BotFather: /mybots → выбрать бота → Bot Settings → Group Privacy → Turn off.\n" +
              "Кто может писать: /users; добавить — /allowuser <id|@user>. Отключить группу — /forgethere.",
          );
        }
      } else if (cmd === "/forgethere") {
        await saveConfig({ botGroupChatId: undefined });
        await reply("🚫 Больше не отвечаю в группах автоматически (ассистент-группа сброшена).");
      } else if (cmd === "/monitors") {
        await reply(fmtMonitors((await h.monitor_list!({}).catch(() => [])) as any[]));
      } else if (cmd === "/schedules") {
        await reply(fmtSchedules((await h.schedule_list!({}).catch(() => [])) as any[]));
      } else if (cmd === "/users") {
        await reply(fmtBotUsers((await h.bot_users_list!({}).catch(() => [])) as any[]));
      } else if (cmd === "/allowuser") {
        if (!arg) await reply("Использование: /allowuser <id|@username>");
        else {
          try {
            const u = (await h.bot_user_allow!({ user: arg })) as { id: number };
            notifiedUnknown.delete(u.id);
            await reply(`✅ Теперь боту может писать: ${arg} (id ${u.id}).`);
          } catch (e) {
            await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else if (cmd === "/denyuser") {
        if (!arg) await reply("Использование: /denyuser <id|@username>");
        else {
          try {
            const r = (await h.bot_user_deny!({ user: arg })) as { removed: boolean };
            await reply(r.removed ? `🚫 Больше не может писать боту: ${arg}.` : `Не найден в списке: ${arg}.`);
          } catch (e) {
            await reply(`Не вышло: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else if (cmd === "/grant" || cmd === "/revoke" || cmd === "/permissions") {
        // Раздача разрешений на отправку убрана: писать можно в любой чат свободно.
        await reply("Разрешения на отправку больше не нужны — я могу писать в любой чат. По умолчанию пишу только по твоей просьбе/правилу.");
      } else if (isCmd) {
        await reply("Неизвестная команда. /help — список команд.");
      } else {
        // обычный текст → событие агенту; ответ уйдёт его текстом В ЭТОТ чат (target=to).
        await h.bot_typing!({ chat_id: to }).catch(() => {});
        pushEvent({ botMessages: [m], replyTo: { chatId: to, isOwner } }, to);
      }
    }
  }

  // Общая инициализация: layout, конфиг, lock(порт тенанта), клиент, хаб-хендлеры.
  // Возвращает аккаунт владельца (валидирует авторизацию РАНО, чтобы битый тенант не
  // занимал lock/порт и не ронял процесс). Бросает при невалидной сессии — main это
  // ловит и ПРОПУСКАЕТ тенанта, остальные продолжают работать.
  async function init(): Promise<{ name: string }> {
    await ensureDataLayout();
    const cfg = await requireConfig();
    if (!(await hasSession())) {
      throw new Error(`нет входа в Telegram (выполните: bun run tg login ${ctx.name})`);
    }
    currentModel = cfg.model;
    currentEffort = cfg.effort;
    engine = cfg.agent;
    botUsername = cfg.botUsername;

    // 1) Клиент + проверка авторизации ДО захвата lock/порта.
    tg = await createClient();
    await tg.connect();
    let me: { displayName: string };
    try {
      me = await tg.getMe();
    } catch (e) {
      await tg.destroy().catch(() => {});
      tg = undefined;
      throw new Error(`сессия Telegram недействительна (${e instanceof Error ? e.message : e}); войдите заново: bun run tg login ${ctx.name}`);
    }

    // 2) Авторизация ок — берём свободный порт и ПОДГОТАВЛИВАЕМ координаты (без записи
    // lock). Сначала реально поднимаем хаб (он должен слушать порт), и только ПОСЛЕ
    // успешного бинда атомарно пишем lock. Иначе окно: lock уже на диске (порт/токен),
    // а хаб ещё не слушает — потребитель схватил бы мёртвый порт/токен.
    hubPort = pickPort(ctx.hubPort);
    const lock = await prepareLock(hubPort);
    hubToken = lock.token;
    const st0 = await loadState();
    agentSessionId = st0.agentSessionId;
    codexThreadId = st0.codexThreadId;
    agentUsage = st0.agentUsage ?? freshUsage();
    handlers = buildHandlers(tg, sessionCtx);
    server = startHubServer(handlers, lock.token, lock.port, ctx);
    await writeLock(lock); // хаб слушает — теперь публикуем координаты в lock
    return { name: me.displayName };
  }

  function fireLoops(): void {
    const h = handlers!;
    // long-poll бота
    (async () => {
      while (!stopping && !globalStopping) {
        try {
          const r = (await h.bot_poll!({ timeout: 20 })) as {
            configured: boolean;
            newMessages: any[];
            unauthorized?: { fromId: number; fromUsername: string | null }[];
          };
          if (!r.configured) {
            await sleep(5000);
            continue;
          }
          await handleBotMessages(r.newMessages);
          if (r.unauthorized?.length) await notifyUnauthorized(r.unauthorized);
        } catch (e) {
          lg("bot long-poll:", e instanceof Error ? e.message : e);
          await sleep(3000);
        }
      }
    })();
    // детектор чатов/мониторов/расписаний
    (async () => {
      while (!stopping && !globalStopping) {
        await sleep(DETECT_SECONDS * 1000);
        try {
          await detect();
        } catch (e) {
          lg("детектор:", e instanceof Error ? e.message : e);
        }
      }
    })();
    // индикатор «печатает…», пока агент работает
    (async () => {
      while (!stopping && !globalStopping) {
        if (inflight > 0) await h.bot_typing!({ chat_id: currentTarget() }).catch(() => {});
        await sleep(4000);
      }
    })();
    // периодическая проверка обновлений
    const updateCheckMs = Math.max(1, Number(process.env.TG_UPDATE_CHECK_HOURS ?? 24)) * 3600 * 1000;
    (async () => {
      await sleep(30000);
      while (!stopping && !globalStopping) {
        try {
          const ch = await checkForUpdate();
          if (ch.ok && ch.hasUpdate && ch.latest) {
            const st = await loadState();
            if (st.notifiedUpdateVersion !== ch.latest) {
              await h.bot_send!({ text: `🆕 Доступна новая версия tg: ${ch.latest} (у тебя ${ch.current}).${ch.notes ? `\n\nИзменения:\n${ch.notes}` : ""}\n\nОбновить: /update` }).catch(() => {});
              await updateState((s) => {
                s.notifiedUpdateVersion = ch.latest;
              });
            }
          }
        } catch (e) {
          lg("проверка обновлений:", e instanceof Error ? e.message : e);
        }
        await sleep(updateCheckMs);
      }
    })();
  }

  async function startService(): Promise<void> {
    await withTenant(ctx, async () => {
      try {
        const me = await init();
        await startSession(agentSessionId);
        await registerBotCommands().catch(() => {});
        await appendProgress(`service: старт тенанта ${ctx.name} (движок ${engine})`);
        lg(`Запущен как ${me.name}. Движок=${engine}, модель=${currentModel}${currentEffort ? ", effort=" + currentEffort : ""}, порт ${hubPort}. Сессия: ${agentSessionId ? "продолжаю " + agentSessionId.slice(0, 8) : "новая"}.`);
        fireLoops();
      } catch (e) {
        await stop().catch(() => {}); // освободить lock/клиент/порт, если что-то заняли
        throw e; // main посчитает тенанта незапустившимся и продолжит с остальными
      }
    });
  }

  async function runOnce(): Promise<void> {
    await withTenant(ctx, async () => {
      try {
        await init();
        await startSession(agentSessionId);
        lg(`--once: один проход. Движок=${engine}, модель=${currentModel}.`);
        const r = (await handlers!.bot_poll!({ timeout: 0 })) as { configured: boolean; newMessages: any[]; unauthorized?: any[] };
        if (r.configured && r.newMessages.length) await handleBotMessages(r.newMessages);
        if (r.configured && r.unauthorized?.length) await notifyUnauthorized(r.unauthorized);
        await detect();
        const deadline = Date.now() + 120000;
        while (inflight > 0 && Date.now() < deadline) await sleep(500);
      } finally {
        await stop();
      }
    });
  }

  async function stop(): Promise<void> {
    stopping = true;
    try {
      server?.stop(true);
    } catch {
      /* ignore */
    }
    await session?.close().catch(() => {});
    tg?.destroy().catch(() => {});
    await withTenant(ctx, () => releaseLock()).catch(() => {});
  }

  return { ctx, startService, runOnce, stop };
}

// ---------- перечисление тенантов и запуск ----------

async function resolveContexts(): Promise<TenantContext[]> {
  // TG_ONLY_TENANT — запустить ровно один тенант (используется мастером setup, а также
  // если нужно поднять конкретного пользователя отдельно).
  const only = process.env.TG_ONLY_TENANT;
  if (only) return [tenantContext(only, 0)];

  // Никакого legacy-режима: при наличии старой data/ её автоматически мигрируем в tenants/.
  const migrated = await autoMigrateLegacy();
  if (migrated) log(`✅ Авто-миграция: data/ → ${migrated} (запускаю как тенант).`);

  const names = await listTenants();
  return names.map((n, i) => tenantContext(n, i));
}

async function main(): Promise<void> {
  // Защита мультитенанта: стрэй-ошибка фонового цикла одного тенанта (напр. сетевой сбой
  // mtcute) НЕ должна ронять весь процесс и остальных пользователей. Логируем и живём.
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection (продолжаю):", reason instanceof Error ? reason.message : reason);
  });

  const once = process.argv.includes("--once");
  const contexts = await resolveContexts();
  if (contexts.length === 0) {
    fail("Нет ни одного тенанта. Создай: bun run tg tenant add <имя> (затем bun run tg login <имя>).");
    process.exit(1);
  }

  for (const ctx of contexts) allRuntimes.push(createTenantRuntime(ctx));

  if (once) {
    for (const rt of allRuntimes) {
      try {
        await rt.runOnce();
      } catch (e) {
        log(`[${rt.ctx.name}] --once ошибка:`, e instanceof Error ? e.message : e);
      }
    }
    process.exit(0);
  }

  const stopAll = () => {
    if (globalStopping) process.exit(0);
    globalStopping = true;
    log("Останавливаюсь…");
    void Promise.all(allRuntimes.map((r) => r.stop().catch(() => {}))).finally(() => {
      setTimeout(() => process.exit(0), 200);
    });
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  let started = 0;
  for (const rt of allRuntimes) {
    try {
      await rt.startService();
      started++;
    } catch (e) {
      log(`[${rt.ctx.name}] не удалось запустить:`, e instanceof Error ? e.message : e);
    }
  }
  if (started === 0) {
    fail("Ни один тенант не запустился. Проверьте логи выше (вход в Telegram, конфиг).");
    process.exit(1);
  }
  log(`Готов. Тенантов запущено: ${started}/${contexts.length}. Реакция: бот — мгновенно, чаты/мониторы — ~${DETECT_SECONDS}с.`);
}

main().catch(async (err) => {
  fail("Фатальная ошибка сервиса:", err instanceof Error ? err.message : err);
  process.exit(1);
});
