// Сервисный Telegram-БОТ (Bot API, отдельно от user-аккаунта).
//
// Зачем: двусторонний канал «человек ↔ активная сессия агента». Человек пишет боту
// — это команды агенту (как управляющий канал); агент отвечает и пишет проактивно
// (напр. сводки) через бота. Создаётся ботом @BotFather: агент сам ведёт диалог
// через user-аккаунт (tg_send_message/tg_get_history к @BotFather), получает токен и
// сохраняет его (bot_set_token). Дальше бот работает через HTTPS Bot API.

import { loadConfig, saveConfig } from "./config.ts";
import { loadState, updateState } from "./state.ts";
import { recordQa } from "./memory.ts";
import { isBotUserAllowed } from "./botusers.ts";
import { appendFile } from "node:fs/promises";
import { BOT_CHAT_PATH } from "./paths.ts";

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Вся переписка с ботом — на диск (для других агентов и истории).
async function logBotChat(dir: string, text: string): Promise<void> {
  await appendFile(BOT_CHAT_PATH, `## ${stamp()} · ${dir}\n${text}\n\n`, "utf8").catch(() => {});
}

// Лимит длины сообщения Telegram — 4096 символов. Бьём длинный текст на части по
// границам абзацев/строк, помечаем «📄 i/n», стараемся не рвать код-блоки (```).
const TG_LIMIT = 4096;
export function splitMessage(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const EFFECTIVE = Math.max(500, limit - 24); // запас под заголовок «📄 i/n»
  // Пред-разрезаем слишком длинные строки, чтобы основной цикл не видел строк > лимита.
  const lines: string[] = [];
  for (const l of text.split("\n")) {
    if (l.length <= EFFECTIVE) lines.push(l);
    else for (let i = 0; i < l.length; i += EFFECTIVE) lines.push(l.slice(i, i + EFFECTIVE));
  }
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let fenceOpen = false;
  const flush = () => {
    if (cur.length === 0) return;
    chunks.push(cur.join("\n") + (fenceOpen ? "\n```" : ""));
    cur = fenceOpen ? ["```"] : [];
    curLen = fenceOpen ? 3 : 0;
  };
  for (const line of lines) {
    const add = (cur.length > 0 ? 1 : 0) + line.length;
    if (curLen + add > EFFECTIVE && cur.length > 0) flush();
    cur.push(line);
    curLen += (cur.length > 1 ? 1 : 0) + line.length;
    if (line.trim().startsWith("```")) fenceOpen = !fenceOpen;
  }
  flush();
  const n = chunks.length;
  return n <= 1 ? chunks : chunks.map((c, i) => `📄 ${i + 1}/${n}\n${c}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api<T = any>(token: string, method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description ?? `Bot API error: ${method}`);
  return data.result as T;
}

export async function botStatus() {
  const cfg = await loadConfig();
  if (!cfg.botToken) return { configured: false as const, hint: "Бота нет. Создайте через @BotFather и сохраните токен (bot_set_token)." };
  try {
    const me = await api(cfg.botToken, "getMe");
    return {
      configured: true as const,
      username: me.username as string,
      name: me.first_name as string,
      link: `https://t.me/${me.username}`,
      ownerChatKnown: cfg.botOwnerChatId != null,
    };
  } catch (e) {
    return { configured: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Проверяет токен (getMe) и сохраняет его + username в конфиг. Заодно регистрирует
 *  меню команд и описание бота, чтобы в Telegram сразу были подсказки. */
export async function setBotToken(token: string) {
  const me = await api(token, "getMe");
  await saveConfig({ botToken: token, botUsername: me.username });
  await registerBotCommands(token).catch(() => {});
  return { ok: true, username: me.username as string, link: `https://t.me/${me.username}` };
}

// Подсказки команд в Telegram (показываются в меню «/» и при наборе). Описание/команды
// обновляются идемпотентно — можно звать на каждом старте сервиса.
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "help", description: "что умею и список команд" },
  { command: "start", description: "приветствие и возможности" },
  { command: "context", description: "контекст и расход текущей сессии" },
  { command: "new", description: "новая сессия (очистить контекст)" },
  { command: "compact", description: "сжать контекст в память" },
  { command: "model", description: "сменить модель: /model <opus|sonnet|…>" },
  { command: "effort", description: "уровень усилия: /effort <low|…>" },
  { command: "monitors", description: "активные мониторы" },
  { command: "schedules", description: "расписания" },
  { command: "permissions", description: "кому агент может писать" },
  { command: "grant", description: "разрешить агенту писать в чат: /grant <chat>" },
  { command: "revoke", description: "отозвать разрешение: /revoke <chat>" },
  { command: "users", description: "кто может писать боту" },
  { command: "allowuser", description: "разрешить писать боту: /allowuser <id|@user>" },
  { command: "denyuser", description: "запретить писать боту: /denyuser <id|@user>" },
  { command: "version", description: "версия и проверка обновлений" },
  { command: "update", description: "обновить tg до последней версии" },
  { command: "restart", description: "перезапустить агента (если запущен сервисом)" },
];

const BOT_DESCRIPTION =
  "ИИ-агент твоего личного Telegram. Пиши мне обычным текстом — отвечу и выполню. " +
  "Команда /start — что я умею.";
const BOT_SHORT_DESCRIPTION = "ИИ-агент личного Telegram. /start — возможности.";

/** Регистрирует подсказки команд и описание бота через Bot API (идемпотентно). */
export async function registerBotCommands(token?: string): Promise<{ ok: boolean }> {
  const t = token ?? (await loadConfig()).botToken;
  if (!t) return { ok: false };
  await api(t, "setMyCommands", { commands: BOT_COMMANDS });
  await api(t, "setMyDescription", { description: BOT_DESCRIPTION }).catch(() => {});
  await api(t, "setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION }).catch(() => {});
  return { ok: true };
}

export interface BotIncoming {
  updateId: number;
  messageId: number;
  fromId: number;
  fromUsername: string | null;
  chatId: number;
  text: string;
  /** true, если написал сам владелец аккаунта (а не разрешённый пользователь). */
  isOwner: boolean;
}

/** Тот, кто постучался боту, но не в списке разрешённых (для уведомления владельцу). */
export interface BotUnauthorized {
  fromId: number;
  fromUsername: string | null;
  chatId: number;
}

/**
 * Забирает новые сообщения, присланные боту. Принимает сообщения ВЛАДЕЛЬЦА (ownerId)
 * и явно разрешённых пользователей (data/bot-users.json). Остальных — игнорирует и
 * возвращает в unauthorized (сервис уведомит владельца). Команды дословно пишет в
 * data/qa. Двигает offset getUpdates.
 */
export async function botPoll(
  ownerId?: number,
  timeoutSec = 0,
): Promise<{ configured: boolean; newMessages: BotIncoming[]; unauthorized: BotUnauthorized[] }> {
  const cfg = await loadConfig();
  if (!cfg.botToken) return { configured: false, newMessages: [], unauthorized: [] };
  const state = await loadState();
  const offset = state.botUpdateOffset ?? 0;
  const updates = await api<any[]>(cfg.botToken, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] });

  const out: BotIncoming[] = [];
  const unauthorized: BotUnauthorized[] = [];
  let maxUpd = offset - 1;
  let ownerChat = cfg.botOwnerChatId;
  for (const u of updates) {
    maxUpd = Math.max(maxUpd, u.update_id);
    const m = u.message;
    if (!m || typeof m.text !== "string" || m.text.length === 0) continue;
    if (m.chat?.type !== "private") continue; // бот работает только в личке (не в группах)
    const fromId = m.from?.id as number | undefined;
    if (fromId == null) continue;
    const isOwner = ownerId == null || fromId === ownerId;
    if (!isOwner && !(await isBotUserAllowed(fromId))) {
      unauthorized.push({ fromId, fromUsername: m.from?.username ?? null, chatId: m.chat.id });
      continue; // не владелец и не в allowlist — игнорируем
    }
    if (isOwner) ownerChat = m.chat.id; // chat владельца для проактивных сообщений бота
    await recordQa(m.text, `bot:${m.from?.username ?? fromId}`);
    await logBotChat(isOwner ? "👤 человек" : `👥 ${m.from?.username ?? fromId}`, m.text);
    out.push({ updateId: u.update_id, messageId: m.message_id, fromId, fromUsername: m.from?.username ?? null, chatId: m.chat.id, text: m.text, isOwner });
  }
  if (maxUpd >= offset) {
    await updateState((s) => {
      s.botUpdateOffset = maxUpd + 1;
    });
  }
  if (ownerChat && ownerChat !== cfg.botOwnerChatId) await saveConfig({ botOwnerChatId: ownerChat });
  return { configured: true, newMessages: out, unauthorized };
}

// Отправляет один кусок: сначала как Telegram MarkdownV2; если разметка невалидна
// (Telegram вернёт ошибку парсинга) — повторяет обычным текстом, чтобы сообщение НЕ
// потерялось. Так агент может форматировать MarkdownV2, а наши ошибки не фатальны.
async function sendOnePart(token: string, chat: number, text: string): Promise<{ message_id: number }> {
  try {
    return await api(token, "sendMessage", { chat_id: chat, text, parse_mode: "MarkdownV2" });
  } catch {
    return await api(token, "sendMessage", { chat_id: chat, text });
  }
}

/** Бот пишет человеку (по умолчанию — владельцу в его чат с ботом). Текст
 *  форматируется как MarkdownV2 (с фолбэком на обычный текст), длинное — режется. */
export async function botSend(text: string, chatId?: number) {
  const cfg = await loadConfig();
  if (!cfg.botToken) throw new Error("Бот не настроен. Сначала создайте бота и сохраните токен (bot_set_token).");
  const chat = chatId ?? cfg.botOwnerChatId;
  if (!chat) {
    throw new Error("Неизвестен chat_id владельца. Пусть человек напишет боту /start.");
  }
  const parts = splitMessage(text);
  let last: { message_id: number } | undefined;
  for (const part of parts) {
    last = await sendOnePart(cfg.botToken, chat, part);
  }
  await logBotChat("🤖 бот", text);
  return { ok: true, chatId: chat, messageId: last?.message_id ?? 0, text, parts: parts.length };
}

/** Стилизованное промежуточное «статус»-сообщение (видно, что идёт работа). */
export async function botProgress(text: string, chatId?: number) {
  return botSend(`💭 ${text}`, chatId);
}

/** Показывает в чате бота статус «печатает…» (Bot API sendChatAction). Длится ~5с;
 *  чтобы держать индикатор, его надо переотправлять каждые ~4с, пока идёт работа. Если
 *  переотправка прекращается (агент ответил или умер) — индикатор гаснет сам. */
export async function botTyping(chatId?: number) {
  const cfg = await loadConfig();
  if (!cfg.botToken) return { ok: false };
  const chat = chatId ?? cfg.botOwnerChatId;
  if (!chat) return { ok: false };
  await api(cfg.botToken, "sendChatAction", { chat_id: chat, action: "typing" });
  return { ok: true };
}

/** Реакция-эмодзи на сообщение в чате бота (Bot API setMessageReaction). */
export async function botReact(chatId: number, messageId: number, emoji = "👀") {
  const cfg = await loadConfig();
  if (!cfg.botToken) throw new Error("Бот не настроен.");
  await api(cfg.botToken, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
  return { ok: true, chatId, messageId, emoji };
}
