// Локальный RPC между MCP-сервером (прокси) и сервисом-владельцем (хабом).
//
// Архитектура: ЕДИНСТВЕННЫЙ процесс-сервис владеет Telegram-сессией и поднимает
// этот RPC на localhost. Все остальные (MCP для Claude Code/Codex, live-агент)
// НЕ открывают сессию сами, а вызывают сервис через hubCall(). Так с Telegram
// работает только один процесс — конфликтов за bun:sqlite-сессию нет.
//
// Авторизация: хаб требует bearer-токен (см. lib/lock.ts). Прокси берёт порт и токен
// из env (TG_HUB_PORT/TG_HUB_TOKEN — их передаёт сервис своему live-MCP) либо из
// data/service.lock (для интерактивных Claude Code/Codex, запущенных человеком сам).

import { readLock } from "./lock.ts";

/** Порт по умолчанию для БИНДА хаба сервисом (вызовы используют resolveHub). */
export const HUB_PORT: number = Number(process.env.TG_HUB_PORT ?? 8765);

export interface RpcRequest {
  op: string;
  args?: Record<string, unknown>;
}

async function resolveHub(): Promise<{ port: number; token?: string }> {
  const envPort = process.env.TG_HUB_PORT ? Number(process.env.TG_HUB_PORT) : undefined;
  const envToken = process.env.TG_HUB_TOKEN;
  if (envPort && envToken) return { port: envPort, token: envToken };
  const lock = await readLock();
  return { port: envPort ?? lock?.port ?? 8765, token: envToken ?? lock?.token };
}

/** Вызвать операцию у запущенного сервиса. Кидает понятную ошибку, если сервис не поднят. */
export async function hubCall<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const { port, token } = await resolveHub();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op, args } satisfies RpcRequest),
    });
  } catch {
    throw new Error("Сервис не запущен (с Telegram работает только он). Запустите: bun run service");
  }
  if (res.status === 401) {
    throw new Error("Хаб отклонил запрос (нет/неверный токен). Перезапустите сервис: bun run service");
  }
  const data = (await res.json()) as { result?: T; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result as T;
}
