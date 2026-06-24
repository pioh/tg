// Высокоуровневые операции над Telegram от имени пользователя.
// Тонкие, предсказуемые обёртки над mtcute — их вызывает MCP-сервер.
// Возвращают сериализуемые в JSON объекты (без классов mtcute).

import type { TelegramClient, Message, Peer } from "@mtcute/bun";
import { InputMedia, FileLocation } from "@mtcute/bun";
import { extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { downloadsDir } from "../lib/paths.ts";

// chatId из MCP приходит строкой: "me"/"self", @username, username или числовой id.
function coercePeer(chatId: string | number): string | number {
  if (typeof chatId === "number") return chatId;
  const s = chatId.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  return s; // username / "me" / phone
}

// ---------- описание собеседника/чата ----------

export type PeerKind = "user" | "bot" | "group" | "supergroup" | "channel" | "gigagroup" | "monoforum";

interface PeerInfo {
  id: number;
  name: string;
  username: string | null;
  kind: PeerKind;
}
function peerInfo(peer: Peer): PeerInfo {
  let kind: PeerKind;
  if (peer.type === "user") kind = peer.isBot ? "bot" : "user";
  else kind = peer.chatType; // 'group' | 'supergroup' | 'channel' | 'gigagroup' | 'monoforum'
  return { id: peer.id, name: peer.displayName ?? "", username: peer.username ?? null, kind };
}

// ---------- описание медиа (все типы сообщений) ----------

interface MediaInfo {
  kind: string; // photo|video|voice|audio|document|sticker|poll|location|contact|...
  downloadable: boolean;
  [k: string]: unknown;
}
function mediaInfo(media: Message["media"]): MediaInfo | null {
  if (!media) return null;
  const base: MediaInfo = { kind: media.type, downloadable: media instanceof FileLocation };
  switch (media.type) {
    case "photo":
      return { ...base, spoiler: media.hasSpoiler };
    case "video":
      return { ...base, duration: media.duration, width: media.width, height: media.height };
    case "voice":
      return { ...base, duration: media.duration };
    case "audio":
      return { ...base, duration: media.duration, title: media.title };
    case "document":
      return { ...base, fileName: media.fileName, mimeType: media.mimeType };
    case "sticker":
      return { ...base, emoji: media.emoji, width: media.width, height: media.height };
    case "poll":
      return { ...base, question: media.question };
    case "location":
    case "live_location":
      return { ...base, latitude: media.latitude, longitude: media.longitude };
    case "dice":
      return { ...base, emoji: media.emoji };
    case "contact":
      return { ...base, phone: media.phoneNumber, firstName: media.firstName };
    case "game":
    case "invoice":
      return { ...base, title: media.title };
    default:
      return base; // webpage/venue/story/paid/todo и т.п. — хотя бы kind
  }
}

// ---------- описание сообщения (полный контекст) ----------

export interface MessageLite {
  id: number;
  date: string;
  outgoing: boolean;
  sender: PeerInfo | null;
  text: string;
  media: MediaInfo | null;
  reply?: { toMessageId: number | null; toText?: string };
  forwardFrom?: string;
  viaBot?: string;
  edited?: boolean;
  pinned?: boolean;
  service?: string; // тип сервисного действия (вступил/закрепил/...)
  topicId?: number | null;
}
export function messageLite(m: Message): MessageLite {
  const out: MessageLite = {
    id: m.id,
    date: m.date instanceof Date ? m.date.toISOString() : String(m.date),
    outgoing: m.isOutgoing,
    sender: m.sender ? peerInfo(m.sender) : null,
    text: m.text ?? "",
    media: mediaInfo(m.media),
  };
  if (m.replyToMessage) out.reply = { toMessageId: m.replyToMessage.id };
  if (m.forward) {
    const s = m.forward.sender;
    out.forwardFrom = s && "displayName" in s ? s.displayName : "скрыто";
  }
  if (m.viaBot) out.viaBot = m.viaBot.username ?? m.viaBot.displayName;
  if (m.editDate) out.edited = true;
  if (m.isPinned) out.pinned = true;
  if (m.isService && m.action) out.service = m.action.type;
  if (m.isTopicMessage && m.replyToMessage?.threadId != null) out.topicId = m.replyToMessage.threadId;
  return out;
}

// Прикрепляет текст процитированного сообщения, если оно есть в выборке (без доп. запросов).
function enrichReplies(msgs: MessageLite[], raw: Message[]): MessageLite[] {
  const byId = new Map<number, string>();
  for (const m of raw) byId.set(m.id, m.text ?? "");
  for (const m of msgs) {
    if (m.reply?.toMessageId != null) {
      const t = byId.get(m.reply.toMessageId);
      if (t) m.reply.toText = t.slice(0, 200);
    }
  }
  return msgs;
}

// ---------- операции ----------

export async function whoami(tg: TelegramClient) {
  const me = await tg.getMe();
  return { id: me.id, name: me.displayName, username: me.username ?? null, phone: me.phoneNumber ?? null };
}

export interface DialogLite extends PeerInfo {
  unread: number;
  muted: boolean;
  forum: boolean;
  lastMessage: string;
  lastMessageDate: string | null;
}

export async function listDialogs(tg: TelegramClient, limit = 50, onlyUnread = false): Promise<DialogLite[]> {
  const out: DialogLite[] = [];
  for await (const d of tg.iterDialogs({ limit: onlyUnread ? Math.max(limit, 200) : limit })) {
    if (onlyUnread && d.unreadCount <= 0) continue;
    const peer = d.peer;
    out.push({
      ...peerInfo(peer),
      unread: d.unreadCount,
      muted: Boolean(d.isMuted),
      forum: peer.type === "chat" ? peer.isForum : false,
      lastMessage: (d.lastMessage?.text ?? "").slice(0, 200),
      lastMessageDate: d.lastMessage?.date ? d.lastMessage.date.toISOString() : null,
    });
    if (onlyUnread && out.length >= limit) break;
  }
  return out;
}

export async function getHistory(tg: TelegramClient, chatId: string, limit = 30): Promise<MessageLite[]> {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  const msgs = await tg.getHistory(peer, { limit });
  const chrono = [...msgs].reverse(); // от старых к новым
  return enrichReplies(chrono.map(messageLite), chrono);
}

// ---------- форумы / топики ----------

export interface TopicLite {
  id: number;
  title: string;
  unread: number;
  closed: boolean;
  pinned: boolean;
  lastMessage: string;
}
export async function listTopics(tg: TelegramClient, chatId: string, limit = 50): Promise<TopicLite[]> {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  const topics = await tg.getForumTopics(peer, { limit });
  return topics.map((t) => ({
    id: t.id,
    title: t.title,
    unread: t.unreadCount,
    closed: t.isClosed,
    pinned: t.isPinned,
    lastMessage: (t.lastMessage?.text ?? "").slice(0, 200),
  }));
}

export async function getTopicHistory(
  tg: TelegramClient,
  chatId: string,
  topicId: number,
  limit = 30,
): Promise<MessageLite[]> {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  // Сообщения топика читаются как тред (threadId = id топика).
  const msgs = await tg.searchMessages({ chatId: peer, threadId: topicId, limit });
  const chrono = [...msgs].reverse();
  return enrichReplies(chrono.map(messageLite), chrono);
}

// ---------- отправка / поиск / чтение ----------

export async function sendMessage(tg: TelegramClient, chatId: string, text: string, replyTo?: number) {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  const msg = await tg.sendText(peer, text, replyTo ? { replyTo } : undefined);
  // chatPeerId нужен серверу, чтобы не перечитать собственное сообщение в управляющем канале.
  return { id: msg.id, chatId, chatPeerId: msg.chat.id, sentText: text };
}

export async function searchMessages(
  tg: TelegramClient,
  query: string,
  chatId?: string,
  limit = 30,
): Promise<MessageLite[]> {
  if (chatId) {
    const peer = await tg.resolvePeer(coercePeer(chatId));
    const res = await tg.searchMessages({ chatId: peer, query, limit });
    return res.map(messageLite);
  }
  const res = await tg.searchGlobal({ query, limit });
  return res.map(messageLite);
}

export async function markRead(tg: TelegramClient, chatId: string) {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  await tg.readHistory(peer);
  return { chatId, ok: true };
}

export async function resolve(tg: TelegramClient, query: string): Promise<PeerInfo> {
  const full = await tg.getPeer(coercePeer(query));
  return peerInfo(full);
}

// ---------- медиа: скачивание + просмотр (vision) ----------

function mediaExtension(media: Message["media"]): string {
  if (!media) return "";
  switch (media.type) {
    case "photo":
      return ".jpg";
    case "video":
      return ".mp4";
    case "voice":
      return ".ogg";
    case "sticker":
      return ".webp";
    case "audio":
    case "document": {
      const fromName = extname(media.fileName ?? "");
      return fromName || "";
    }
    default:
      return "";
  }
}

function isViewableImage(media: Message["media"]): boolean {
  if (!media) return false;
  if (media.type === "photo") return true;
  if (media.type === "document") return (media.mimeType ?? "").startsWith("image/");
  return false;
}

function imageMime(media: Message["media"]): string {
  if (media?.type === "document" && media.mimeType) return media.mimeType;
  return "image/jpeg";
}

export interface MediaResult {
  kind: string;
  path: string;
  /** для картинок — данные для инлайн-просмотра моделью (vision) */
  image?: { base64: string; mimeType: string };
  fileName?: string | null;
  note?: string;
}

export async function getMedia(tg: TelegramClient, chatId: string, messageId: number): Promise<MediaResult> {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  const [msg] = await tg.getMessages(peer, messageId);
  if (!msg || !msg.media) throw new Error("В сообщении нет медиа или оно не найдено.");
  const media = msg.media;
  if (!(media instanceof FileLocation)) {
    throw new Error(`Это медиа (${(media as { type?: string }).type}) нельзя скачать.`);
  }
  await mkdir(downloadsDir(), { recursive: true });
  const ext = mediaExtension(media);
  const path = join(downloadsDir(), `${chatId.replace(/[^\w-]/g, "_")}_${messageId}${ext}`);
  await tg.downloadToFile(path, media);

  const result: MediaResult = {
    kind: media.type,
    path,
    fileName: media.type === "document" ? media.fileName : null,
  };
  if (isViewableImage(media)) {
    const bytes = await Bun.file(path).bytes();
    result.image = { base64: Buffer.from(bytes).toString("base64"), mimeType: imageMime(media) };
  } else {
    result.note = "Не изображение — сохранено на диск; инлайн-просмотр недоступен.";
  }
  return result;
}

export async function sendFile(tg: TelegramClient, chatId: string, path: string, caption?: string) {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  await tg.sendMedia(peer, InputMedia.auto(`file:${path}`, caption ? { caption } : {}));
  return { chatId, path, ok: true };
}

// Реакция-эмодзи на сообщение (например 👀 = «прочитал/увидел»). Это НЕ отметка
// «прочитано» — счётчик непрочитанных не сбрасывается.
export async function react(tg: TelegramClient, chatId: string, messageId: number, emoji = "👀") {
  const peer = await tg.resolvePeer(coercePeer(chatId));
  await tg.sendReaction({ chatId: peer, message: messageId, emoji });
  return { chatId, messageId, emoji, ok: true };
}
