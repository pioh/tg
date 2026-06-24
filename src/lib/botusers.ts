// Кто может писать сервисному боту.
//
// По умолчанию боту может писать ТОЛЬКО владелец (тот аккаунт, под которым вошли в
// Telegram) — его id сервис знает из tg.getMe(). Здесь хранится дополнительный список
// разрешённых: если человек хочет, чтобы боту мог писать ещё кто-то (например, второй
// телефон, коллега, член семьи), он добавляет их сюда. Остальные сообщения боту
// игнорируются, а владельцу приходит уведомление «постучался такой-то — /allowuser <id>».
//
// Хранилище: data/bot-users.json (личное, не в git).

import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

const BOT_USERS_PATH = join(DATA_DIR, "bot-users.json");

export interface BotUser {
  id: number;
  username?: string | null;
  note?: string;
  addedAt: string;
}

interface BotUsersFile {
  allowed: BotUser[];
}

async function load(): Promise<BotUsersFile> {
  const f = Bun.file(BOT_USERS_PATH);
  if (!(await f.exists())) return { allowed: [] };
  try {
    const raw = (await f.json()) as Partial<BotUsersFile>;
    return { allowed: Array.isArray(raw.allowed) ? raw.allowed : [] };
  } catch {
    return { allowed: [] };
  }
}

async function save(data: BotUsersFile): Promise<void> {
  await atomicWriteJson(BOT_USERS_PATH, data);
}

export async function listBotUsers(): Promise<BotUser[]> {
  return (await load()).allowed;
}

export async function isBotUserAllowed(id: number): Promise<boolean> {
  return (await load()).allowed.some((u) => u.id === id);
}

/** Добавляет пользователя в список разрешённых писать боту (идемпотентно). */
export async function allowBotUser(
  id: number,
  opts: { username?: string | null; note?: string } = {},
): Promise<BotUser> {
  const data = await load();
  const existing = data.allowed.find((u) => u.id === id);
  if (existing) {
    if (opts.username !== undefined) existing.username = opts.username;
    if (opts.note !== undefined) existing.note = opts.note;
    await save(data);
    return existing;
  }
  const user: BotUser = { id, username: opts.username ?? null, note: opts.note, addedAt: new Date().toISOString() };
  data.allowed.push(user);
  await save(data);
  return user;
}

/** Убирает пользователя из списка. Возвращает true, если он там был. */
export async function denyBotUser(id: number): Promise<boolean> {
  const data = await load();
  const before = data.allowed.length;
  data.allowed = data.allowed.filter((u) => u.id !== id);
  if (data.allowed.length === before) return false;
  await save(data);
  return true;
}
