// Локальный RPC между MCP-сервером (прокси) и сервисом-владельцем (хабом).
//
// Архитектура: ЕДИНСТВЕННЫЙ процесс-сервис владеет Telegram-сессиями и поднимает на
// localhost по RPC-хабу НА КАЖДОГО тенанта (tenants/<имя>/service.lock хранит порт и
// токен этого тенанта). Все остальные (MCP для Claude Code/Codex, live-агент) НЕ
// открывают сессию сами, а вызывают сервис через hubCall(). Так с Telegram работает
// только один процесс — конфликтов за bun:sqlite-сессию нет.
//
// Как прокси находит хаб (БЕЗ env-выбора тенанта, БЕЗ дефолтов):
//   1) live-MCP, который сервис запускает для агента, получает координаты хаба ЯВНО в
//      env (TG_HUB_PORT + TG_HUB_TOKEN) — тенант там уже зафиксирован сервисом.
//   2) интерактивный MCP (Claude Code/Codex в репозитории) НЕ знает тенанта при старте:
//      его нужно выбрать ЯВНО инструментом set_context(<имя>) — он зовёт setRpcTenant().
//      Тогда resolveHub читает порт/токен из lock ВЫБРАННОГО тенанта.
// Единой папки data/ больше нет (мультитенант), поэтому фолбэка на data/service.lock тут
// тоже нет — без env и без выбранного тенанта вызов осознанно падает с подсказкой.
//
// Авторизация: хаб требует bearer-токен (см. lib/lock.ts). Токен лежит в lock с правами
// 600 — дёрнуть хаб может только тот, кто способен прочитать lock (т.е. сам владелец).

import { join } from "node:path";
import { tenantDir, tenantStore, isTenantName } from "./paths.ts";
import type { LockInfo } from "./lock.ts";

/** Порт по умолчанию для БИНДА хаба сервисом (вызовы используют resolveHub). */
export const HUB_PORT: number = Number(process.env.TG_HUB_PORT ?? 8765);

export interface RpcRequest {
  op: string;
  args?: Record<string, unknown>;
}

// Выбранный тенант для ЭТОГО процесса MCP-прокси (задаётся инструментом set_context).
// Хранится в модульной переменной процесса — НЕ в env (env-переменные «то работают, то
// нет» и могут перемешаться между процессами). Никакого авто-выбора единственного тенанта.
let selectedTenant: string | undefined;

/** Запомнить выбранного тенанта для текущего процесса MCP-прокси (зовёт set_context). */
export function setRpcTenant(name: string): void {
  selectedTenant = name;
}

/** Имя выбранного тенанта (или undefined, если set_context ещё не вызывали). */
export function getRpcTenant(): string | undefined {
  return selectedTenant;
}

/** Активный тенант для вызова хаба: либо явно выбранный set_context (MCP-прокси), либо
 *  явный контекст тенанта из withTenant (CLI: doctor/и т.п.). Оба — ЯВНЫЕ, не дефолты. */
function activeTenant(): string | undefined {
  return selectedTenant ?? tenantStore.getStore()?.name;
}

/** Прочитать lock конкретного тенанта (его файл tenants/<имя>/service.lock). */
async function readTenantLock(name: string): Promise<LockInfo | null> {
  if (!isTenantName(name)) return null; // кривое имя (traversal) — не пытаемся читать
  const f = Bun.file(join(tenantDir(name), "service.lock"));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as LockInfo;
  } catch {
    return null;
  }
}

async function resolveHub(): Promise<{ port: number; token: string }> {
  // 1) Координаты хаба переданы ЯВНО в env (live-MCP, запущенный сервисом для агента).
  const envPort = process.env.TG_HUB_PORT ? Number(process.env.TG_HUB_PORT) : undefined;
  const envToken = process.env.TG_HUB_TOKEN;
  if (envPort && envToken) return { port: envPort, token: envToken };

  // 2) Тенант выбран ЯВНО: set_context (MCP-прокси) или withTenant-контекст (CLI).
  const name = activeTenant();
  if (!name) {
    throw new Error("Тенант не выбран. Сначала вызови set_context(<имя>) (список — list_tenants).");
  }
  const lock = await readTenantLock(name);
  if (!lock) {
    throw new Error(`Нет работающего сервиса у тенанта «${name}» (lock не найден). Запусти: bun run service`);
  }
  return { port: lock.port, token: lock.token };
}

// Признак «соединение отвергнуто» (хаб не слушает на этом порту: сервис перезапущен и
// сменил порт, либо lock устарел). Bun/undici кладёт код в e.code / e.cause.code.
function isConnRefused(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  const code = err?.code ?? err?.cause?.code;
  if (code === "ECONNREFUSED") return true;
  return /ECONNREFUSED|connection refused|failed to connect|unable to connect/i.test(err?.message ?? "");
}

/** Один сетевой вызов /rpc по конкретным координатам. */
async function rpcFetch(port: number, token: string, op: string, args: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ op, args } satisfies RpcRequest),
  });
}

/**
 * Вызвать операцию у запущенного сервиса. Кидает понятную ошибку, если сервис не поднят.
 * На ECONNREFUSED (хаб не слушает) и 401 (токен сменился) ОДИН раз перечитывает lock
 * выбранного тенанта и повторяет запрос — частый случай: сервис перезапустился и сменил
 * порт/токен, а у нас в руках устаревшие координаты. Так не приходится советовать рестарт.
 */
export async function hubCall<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  let { port, token } = await resolveHub();
  // Перечитать lock тенанта (если выбран) и понять, изменились ли координаты.
  const refreshed = async (): Promise<boolean> => {
    const name = activeTenant();
    if (!name) return false; // env-координаты перечитать неоткуда
    const lock = await readTenantLock(name);
    if (!lock) return false;
    if (lock.port === port && lock.token === token) return false; // те же координаты — повтор не поможет
    port = lock.port;
    token = lock.token;
    return true;
  };

  let res: Response;
  try {
    res = await rpcFetch(port, token, op, args);
  } catch (e) {
    if (isConnRefused(e) && (await refreshed())) {
      try {
        res = await rpcFetch(port, token, op, args);
      } catch {
        throw new Error("Сервис не запущен (с Telegram работает только он). Запустите: bun run service");
      }
    } else {
      throw new Error("Сервис не запущен (с Telegram работает только он). Запустите: bun run service");
    }
  }
  if (res.status === 401 && (await refreshed())) {
    res = await rpcFetch(port, token, op, args); // повтор со свежим токеном
  }
  if (res.status === 401) {
    throw new Error("Хаб отклонил запрос (нет/неверный токен). Перезапустите сервис: bun run service");
  }
  const data = (await res.json()) as { result?: T; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result as T;
}
