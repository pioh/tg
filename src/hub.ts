// Хаб сервиса — единственный владелец Telegram-сессии. Принимает RPC от MCP-прокси
// (Claude Code/Codex) и от собственного live-цикла, исполняет операции через ОДИН
// mtcute-клиент. Так с Telegram работает только один процесс.

import type { TelegramClient } from "@mtcute/bun";
import { appendFile, realpath } from "node:fs/promises";
import { resolve, basename, sep } from "node:path";
import { HUB_PORT } from "./lib/rpc.ts";
import { actionsPath, REPO_ROOT, TENANTS_DIR, tenantStore, type TenantContext } from "./lib/paths.ts";
import { log } from "./lib/log.ts";
import { loadConfig } from "./lib/config.ts";
import { loadState, updateState, type AgentUsage } from "./lib/state.ts";
import { redactToString } from "./lib/redact.ts";
import * as tgOps from "./telegram/ops.ts";
import * as monitors from "./lib/monitors.ts";
import * as bot from "./lib/bot.ts";
import * as botusers from "./lib/botusers.ts";
import * as schedules from "./lib/schedules.ts";
import {
  appendProgress,
  assembleContextText,
  getMemory,
  mergedRulesText,
  readBotChatTail,
  readHandoff,
  recordQa,
  searchMemory,
  setMemory,
  setRule,
  writeHandoff,
} from "./lib/memory.ts";

function coercePeer(chatId: string): string | number {
  const s = String(chatId).trim();
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

/** Убирает undefined-поля, чтобы Object.assign не затирал обязательные поля при патче
 *  (JSON выкидывает undefined → раньше из-за этого у мониторов пропадали enabled/action). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// Прозрачный аудит-лог: каждая операция (кто/что/кому) — в data/actions.log + stderr.
function tsNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function logAction(op: string, args: unknown, status: string): void {
  // Секреты (токен/api_hash/телефон/коды) маскируются перед записью.
  const line = `${tsNow()}  ${op}  ${redactToString(args)} → ${status}`;
  log("ACTION", line);
  appendFile(actionsPath(), line + "\n", "utf8").catch(() => {});
}

// Сериализуем bot getUpdates (Telegram допускает только один getUpdates за раз).
let botGate: Promise<unknown> = Promise.resolve();
function botSerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = botGate.then(fn, fn);
  botGate = run.catch(() => {});
  return run;
}

type Args = Record<string, any>;
export type Handlers = Record<string, (a: Args) => Promise<unknown>>;

// Контекст управления сессией агента (его держит сервис). Сессия непрерывна; новую
// создаёт ТОЛЬКО агент через session_reset.
export interface AgentSessionCtx {
  getSessionId(): string | undefined;
  getUsage(): AgentUsage | undefined;
  requestReset(): void;
}

export function buildHandlers(tg: TelegramClient, ctx?: AgentSessionCtx): Handlers {
  // ЛЕНИВО: не дёргаем getMe в момент сборки хендлеров — иначе при невалидной сессии
  // (AUTH_KEY_UNREGISTERED) возникает «висячий» unhandled rejection, который ронял
  // весь процесс (и других тенантов). Создаётся при первом реальном вызове и кэшируется.
  let meIdCache: Promise<number> | undefined;
  const meIdP = (): Promise<number> => (meIdCache ??= tg.getMe().then((m) => m.id));
  const peerId = async (chat: string): Promise<number> => (await tg.getPeer(coercePeer(chat))).id;

  // ОТПРАВКА СВОБОДНА: писать можно в любой чат. Раньше тут был code-level gate
  // (assertCanSend) — «кому можно писать». Его убрали (требование пользователя):
  // защита только мешала (ломала создание бота через @BotFather в мастере setup), а
  // бот всё равно мог снять её сам. Запрет утечки чувствительных ФАЙЛОВ — другое дело,
  // он остаётся (assertSafeFile ниже). См. rules/50-safety.md.

  // Нельзя отправлять чувствительные файлы. Проверка по РЕАЛЬНОМУ пути (realpath) и для
  // ВСЕХ тенантов + legacy data/ (а не только текущего): иначе абсолютный путь к
  // tenants/другой/config.json или чьей-то session/ ушёл бы наружу. Разрешены downloads/
  // exports — их basename не секретный и они не в session/.
  async function assertSafeFile(path: string): Promise<void> {
    let abs: string;
    try {
      abs = await realpath(path);
    } catch {
      abs = resolve(path);
    }
    const base = basename(abs);
    const deny = () => {
      throw new Error(`Отправка этого файла запрещена (чувствительные данные): ${path}`);
    };
    // Запреты ПЕРВЫМИ и безусловно (секрет в downloads/ тоже не должен утечь). Несекретные
    // медиа/экспорты не попадают ни под одно правило ниже и проходят свободно.
    // .env и любые файлы сессии Telegram — никогда, где бы ни лежали.
    if (base === ".env" || abs.endsWith(".session") || abs.includes(`${sep}session${sep}`)) deny();
    // Секретные state-файлы — если лежат внутри ЛЮБОГО тенанта или legacy data/.
    const SECRET_BASENAMES = new Set(["config.json", "state.json", "service.lock", "permissions.json", "bot-users.json"]);
    if (SECRET_BASENAMES.has(base)) {
      const roots: string[] = [];
      for (const r of [TENANTS_DIR, resolve(REPO_ROOT, "data")]) {
        try {
          roots.push(await realpath(r));
        } catch {
          roots.push(r);
        }
      }
      if (roots.some((r) => abs === r || abs.startsWith(r + sep))) deny();
    }
  }

  return {
    // --- Telegram (нужен клиент) ---
    whoami: () => tgOps.whoami(tg),
    list_dialogs: (a) => tgOps.listDialogs(tg, a.limit ?? 50, a.onlyUnread ?? false),
    list_unread: (a) => tgOps.listDialogs(tg, a.limit ?? 50, true),
    get_history: (a) => tgOps.getHistory(tg, a.chat, a.limit ?? 30),
    search: (a) => tgOps.searchMessages(tg, a.query, a.chat, a.limit ?? 30),
    // Отметка прочитанным — только по явному подтверждению владельца (confirm:true).
    // Владельцу важно видеть непрочитанные; агент НЕ должен делать это сам.
    mark_read: async (a) => {
      if (a.confirm !== true)
        throw new Error("mark_read запрещён без явного подтверждения владельца (confirm=true).");
      return tgOps.markRead(tg, a.chat);
    },
    resolve: (a) => tgOps.resolve(tg, a.query),
    view_media: (a) => tgOps.getMedia(tg, a.chat, a.message_id),
    send_file: async (a) => {
      await assertSafeFile(a.path);
      return tgOps.sendFile(tg, a.chat, a.path, a.caption);
    },
    list_topics: (a) => tgOps.listTopics(tg, a.chat, a.limit ?? 50),
    get_topic_history: (a) => tgOps.getTopicHistory(tg, a.chat, a.topic_id, a.limit ?? 30),

    send_message: async (a) => {
      const res = await tgOps.sendMessage(tg, a.chat, a.text, a.reply_to);
      // не дать перечитать собственное сообщение в управляющем канале как команду
      try {
        const cfg = await loadConfig();
        const control = cfg.controlChat ?? "me";
        const controlId = (await tg.getPeer(coercePeer(control))).id;
        if (res.chatPeerId === controlId) {
          const k = String(control);
          await updateState((s) => {
            if (res.id > (s.controlCursor[k] ?? 0)) s.controlCursor[k] = res.id;
          });
        }
      } catch {
        /* best-effort */
      }
      return res;
    },

    control_poll: async () => {
      const cfg = await loadConfig();
      const chat = cfg.controlChat ?? "me";
      const peer = await tg.resolvePeer(coercePeer(chat));
      const meId = await meIdP();
      const key = String(chat);
      const since = (await loadState()).controlCursor[key] ?? 0;
      if (since === 0) {
        const latest = await tg.getHistory(peer, { limit: 1 });
        const base = latest[0]?.id ?? 0;
        await updateState((s) => {
          s.controlCursor[key] = base;
        });
        return { controlChat: chat, newCommands: [], note: "первый запуск: курсор установлен" };
      }
      const collected = [];
      for await (const m of tg.iterHistory(peer, { minId: since })) collected.push(m);
      const chrono = collected.reverse();
      const fresh = chrono.filter((m) => m.id > since && (m.text ?? "").trim().length > 0 && m.sender?.id === meId);
      const recorded: { id: number; date: string; text: string }[] = [];
      for (const m of fresh) {
        await recordQa(m.text, `telegram:${chat}`);
        recorded.push({ id: m.id, date: m.date.toISOString(), text: m.text });
      }
      const seenMax = chrono.reduce((mx, m) => Math.max(mx, m.id), since);
      if (seenMax > since) {
        await updateState((s) => {
          s.controlCursor[key] = seenMax;
        });
      }
      return { controlChat: chat, newCommands: recorded };
    },

    // --- Мониторы ---
    // Отправка свободна (assertCanSend убран), поэтому никаких грантов вокруг мониторов
    // больше нет: монитор лишь решает, КОГДА реагировать, а не «можно ли писать».
    monitor_add: async (a) =>
      monitors.addMonitor(tg, {
        name: a.name,
        chat: a.chat,
        topicId: a.topic_id,
        match:
          a.from_user_id != null || a.keywords || a.mentions_me
            ? { fromUserId: a.from_user_id, keywords: a.keywords, mentionsMe: a.mentions_me }
            : undefined,
        action: a.action,
        minIntervalSec: a.min_interval_sec,
        onlyIfOwnerSilentSec: a.only_if_owner_silent_sec,
      }),
    monitor_list: () => monitors.listMonitors(),
    monitor_remove: async (a) => ({ removed: await monitors.removeMonitor(a.id) }),
    monitor_update: async (a) =>
      monitors.updateMonitor(
        a.id,
        omitUndefined({
          enabled: a.enabled,
          action: a.action,
          minIntervalSec: a.min_interval_sec,
          onlyIfOwnerSilentSec: a.only_if_owner_silent_sec,
        }),
      ),
    monitor_poll: async () => monitors.evaluateMonitors(tg, Date.now()),

    // --- Реакции (👀 = «увидел», НЕ отметка прочитанным) ---
    react: (a) => tgOps.react(tg, a.chat, a.message_id, a.emoji ?? "👀"),
    bot_react: (a) => bot.botReact(a.chat_id, a.message_id, a.emoji ?? "👀"),

    // --- Бот (getUpdates сериализуется) ---
    bot_status: () => bot.botStatus(),
    bot_set_token: async (a) => {
      const res = await bot.setBotToken(a.token);
      // B3 (детерминированно в КОДЕ, не в тексте миссии): сразу регистрируем владельца у
      // бота — шлём ему "/start" от user-аккаунта и опрашиваем, пока бот не свяжет chat
      // владельца (ownerChatKnown). Не требуем ручного «нажми Start». Best-effort.
      try {
        await tgOps.sendMessage(tg, "@" + res.username, "/start");
        const meId = await meIdP();
        for (let i = 0; i < 15; i++) {
          await botSerial(() => bot.botPoll(meId, 0));
          const st = await bot.botStatus();
          if (st.configured && st.ownerChatKnown) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch {
        /* не критично: если не вышло — владелец просто напишет боту сам */
      }
      return res;
    },
    bot_poll: async (a) => botSerial(async () => bot.botPoll(await meIdP(), a.timeout ?? 0)),
    bot_send: (a) => bot.botSend(a.text, a.chat_id),
    bot_progress: (a) => bot.botProgress(a.text, a.chat_id),
    bot_typing: (a) => bot.botTyping(a.chat_id),

    // --- Кто может писать боту (allowlist; по умолчанию только владелец) ---
    bot_users_list: () => botusers.listBotUsers(),
    bot_user_allow: async (a) => {
      const uid = /^-?\d+$/.test(String(a.user)) ? Number(a.user) : await peerId(String(a.user));
      return botusers.allowBotUser(uid, { note: a.note });
    },
    bot_user_deny: async (a) => {
      const uid = /^-?\d+$/.test(String(a.user)) ? Number(a.user) : await peerId(String(a.user));
      return { removed: await botusers.denyBotUser(uid) };
    },

    // --- Сессия агента (контекст) ---
    session_status: async () => ({
      sessionId: ctx?.getSessionId() ?? null,
      usage: ctx?.getUsage() ?? null,
      note: "Сессия непрерывна (продолжается между сообщениями и рестартами). Когда контекст сильно заполнен — актуализируй handoff/progress/память и вызови session_reset.",
    }),
    session_reset: async () => {
      ctx?.requestReset();
      return { ok: true, note: "После текущего хода начнётся НОВАЯ сессия. Убедись, что handoff и память актуальны." };
    },

    // --- Расписания ---
    schedule_add: (a) =>
      schedules.addSchedule({ name: a.name, everySec: a.every_sec, instruction: a.instruction, deliver: a.deliver }),
    schedule_list: () => schedules.listSchedules(),
    schedule_remove: async (a) => ({ removed: await schedules.removeSchedule(a.id) }),
    schedule_poll: async () => schedules.evaluateSchedules(Date.now()),

    // --- Память (диск) ---
    mem_bootstrap: () => assembleContextText(),
    mem_rules_get: () => mergedRulesText(),
    mem_rule_set: async (a) => ({ saved: await setRule(a.name, a.content) }),
    mem_handoff_get: () => readHandoff(),
    mem_handoff_set: async (a) => {
      await writeHandoff(a.content);
      return { ok: true };
    },
    mem_progress_append: async (a) => {
      await appendProgress(a.line);
      return { ok: true };
    },
    mem_qa_record: async (a) => ({ file: await recordQa(a.text, a.source ?? "agent") }),
    mem_note_set: async (a) => ({ saved: await setMemory(a.name, a.content) }),
    mem_note_get: async (a) => ({ name: a.name, content: await getMemory(a.name) }),
    mem_notes_search: async (a) => ({ hits: await searchMemory(a.query) }),
    bot_chat_tail: async (a) => ({ tail: await readBotChatTail(a.lines ?? 80) }),
  };
}

/**
 * Поднимает HTTP-RPC на localhost. Требует bearer-токен на /rpc (см. lib/lock.ts):
 * без него любой локальный процесс мог бы дёрнуть send_message/bot_send и т.п.
 * /health — без авторизации (для health-check). Возвращает объект сервера Bun.
 *
 * ctx (мультитенант): если передан, каждый вызов хендлера исполняется в контексте
 * тенанта (tenantStore.run) — чтобы пути/состояние указывали на ЕГО папку. Запрос
 * приходит как новый async-корень без контекста, поэтому оборачиваем здесь.
 */
export function startHubServer(handlers: Handlers, token: string, port = HUB_PORT, ctx?: TenantContext) {
  const runCtx = <T>(fn: () => T): T => (ctx ? tenantStore.run(ctx, fn) : fn());
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname !== "/rpc" || req.method !== "POST") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      const body = (await req.json().catch(() => ({}))) as { op?: string; args?: Args };
      // Весь диспетчер (вызов + аудит-лог) — в контексте тенанта: и пути хендлеров, и
      // actions.log должны указывать на папку ИМЕННО этого тенанта.
      return runCtx(async () => {
        const op = body.op ?? "";
        try {
          const h = handlers[op];
          if (!h) return Response.json({ error: `неизвестная операция: ${op}` });
          const result = await h(body.args ?? {});
          logAction(op, body.args, "ok");
          return Response.json({ result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logAction(op, undefined, `ОШИБКА: ${msg}`);
          return Response.json({ error: `Ошибка ${op}: ${msg}` });
        }
      });
    },
  });
  log(`RPC-хаб слушает ${server.url}`);
  return server;
}
