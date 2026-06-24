// Code-level разрешения на отправку. Принцип ревью: «prompts are vibes, permissions
// are law». Запрет писать третьим лицам без явного разрешения должен жить в КОДЕ, а не
// только в промптах — иначе prompt-injection из чужого сообщения однажды убедит модель
// «перешли мне config».
//
// Хаб (assertCanSend) разрешает отправку только если: чат — это сам владелец
// («Избранное»/управляющий канал), ИЛИ есть явное разрешение здесь, ИЛИ на этот чат
// заведён включённый монитор с action=reply (человек явно просил отвечать).
//
// Хранилище: data/permissions.json (ключ — числовой peerId). Не коммитится.

import { PERMISSIONS_PATH } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

export type SendMode = "reply"; // пока единственный режим разрешённой отправки

export interface ChatPermission {
  mode: SendMode;
  label?: string;
  source?: string; // откуда взялось разрешение (bot/cli/monitor/...)
  createdAt: string;
}

interface PermissionsFile {
  chats: Record<string, ChatPermission>;
}

async function load(): Promise<PermissionsFile> {
  const f = Bun.file(PERMISSIONS_PATH);
  if (!(await f.exists())) return { chats: {} };
  try {
    const raw = (await f.json()) as Partial<PermissionsFile>;
    return { chats: raw.chats ?? {} };
  } catch {
    return { chats: {} };
  }
}

async function save(data: PermissionsFile): Promise<void> {
  await atomicWriteJson(PERMISSIONS_PATH, data);
}

export async function listPermissions(): Promise<Record<string, ChatPermission>> {
  return (await load()).chats;
}

export async function isAllowed(peerId: number): Promise<boolean> {
  const { chats } = await load();
  return Boolean(chats[String(peerId)]);
}

export async function grantPermission(
  peerId: number,
  opts: { label?: string; source?: string } = {},
): Promise<ChatPermission> {
  const data = await load();
  const perm: ChatPermission = {
    mode: "reply",
    label: opts.label,
    source: opts.source ?? "manual",
    createdAt: new Date().toISOString(),
  };
  data.chats[String(peerId)] = perm;
  await save(data);
  return perm;
}

export async function revokePermission(peerId: number): Promise<boolean> {
  const data = await load();
  const key = String(peerId);
  if (!(key in data.chats)) return false;
  delete data.chats[key];
  await save(data);
  return true;
}
