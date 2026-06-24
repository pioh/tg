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
import { appendFile } from "node:fs/promises";
import { BOT_CHAT_PATH } from "./paths.ts";

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Вся переписка с ботом — на диск (для других агентов и истории).
async function logBotChat(dir: "👤 человек" | "🤖 бот", text: string): Promise<void> {
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

/** Проверяет токен (getMe) и сохраняет его + username в конфиг. */
export async function setBotToken(token: string) {
  const me = await api(token, "getMe");
  await saveConfig({ botToken: token, botUsername: me.username });
  return { ok: true, username: me.username as string, link: `https://t.me/${me.username}` };
}

export interface BotIncoming {
  updateId: number;
  messageId: number;
  fromId: number;
  fromUsername: string | null;
  chatId: number;
  text: string;
}

/**
 * Забирает новые сообщения, присланные боту. Принимает только сообщения владельца
 * (ownerId), если он известен; иначе — первого написавшего (и фиксирует его chat_id).
 * Команды дословно пишет в data/qa. Двигает offset getUpdates.
 */
export async function botPoll(ownerId?: number, timeoutSec = 0): Promise<{ configured: boolean; newMessages: BotIncoming[] }> {
  const cfg = await loadConfig();
  if (!cfg.botToken) return { configured: false, newMessages: [] };
  const state = await loadState();
  const offset = state.botUpdateOffset ?? 0;
  const updates = await api<any[]>(cfg.botToken, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] });

  const out: BotIncoming[] = [];
  let maxUpd = offset - 1;
  let ownerChat = cfg.botOwnerChatId;
  for (const u of updates) {
    maxUpd = Math.max(maxUpd, u.update_id);
    const m = u.message;
    if (!m || typeof m.text !== "string" || m.text.length === 0) continue;
    if (m.chat?.type !== "private") continue; // бот слушает только ЛИЧКУ владельца
    const fromId = m.from?.id as number | undefined;
    if (ownerId != null && fromId !== ownerId) continue; // только владелец
    if (fromId == null) continue;
    ownerChat = m.chat.id;
    await recordQa(m.text, `bot:${m.from?.username ?? fromId}`);
    await logBotChat("👤 человек", m.text);
    out.push({ updateId: u.update_id, messageId: m.message_id, fromId, fromUsername: m.from?.username ?? null, chatId: m.chat.id, text: m.text });
  }
  if (maxUpd >= offset) {
    await updateState((s) => {
      s.botUpdateOffset = maxUpd + 1;
    });
  }
  if (ownerChat && ownerChat !== cfg.botOwnerChatId) await saveConfig({ botOwnerChatId: ownerChat });
  return { configured: true, newMessages: out };
}

/** Бот пишет человеку (по умолчанию — владельцу в его чат с ботом). */
export async function botSend(text: string, chatId?: number) {
  const cfg = await loadConfig();
  if (!cfg.botToken) throw new Error("Бот не настроен. Сначала создайте бота и сохраните токен (bot_set_token).");
  const chat = chatId ?? cfg.botOwnerChatId;
  if (!chat) {
    throw new Error("Неизвестен chat_id владельца. Пусть человек напишет боту /start, затем вызовите bot_poll.");
  }
  const parts = splitMessage(text);
  let last: { message_id: number } | undefined;
  for (const part of parts) {
    last = await api(cfg.botToken, "sendMessage", { chat_id: chat, text: part });
  }
  await logBotChat("🤖 бот", text);
  return { ok: true, chatId: chat, messageId: last?.message_id ?? 0, text, parts: parts.length };
}

/** Стилизованное промежуточное «статус»-сообщение (видно, что идёт работа). */
export async function botProgress(text: string, chatId?: number) {
  return botSend(`💭 ${text}`, chatId);
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
