// Один сервис — один владелец Telegram-сессии. Здесь реализован процессный lock и
// рантайм-координаты хаба: pid, порт RPC и случайный bearer-токен. Файл лежит в
// data/service.lock (личные данные, не в git), пишется с правами 600.
//
// Зачем токен: hub слушает 127.0.0.1, но без авторизации ЛЮБОЙ локальный процесс мог
// бы дёрнуть send_message/bot_send и т.п. Bearer-токен в файле с правами 600 закрывает
// эту дыру: вызвать хаб может только тот, кто может прочитать lock (т.е. сам владелец).

import { unlink, open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { lockPath } from "./paths.ts";

export interface LockInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export async function readLock(): Promise<LockInfo | null> {
  const f = Bun.file(lockPath());
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as LockInfo;
  } catch {
    return null;
  }
}

/** Жив ли процесс с таким pid (kill 0: ESRCH — нет, EPERM — есть). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Отвечает ли /health на этом порту (живой ли хаб). */
async function hubHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Жив ли уже запущенный сервис (по lock-файлу). */
export async function serviceRunning(): Promise<LockInfo | null> {
  const lock = await readLock();
  if (!lock) return null;
  if (await hubHealthy(lock.port)) return lock;
  if (pidAlive(lock.pid)) return lock; // процесс есть, но хаб ещё не поднялся
  return null; // stale
}

function randomToken(): string {
  // crypto доступен в Bun глобально.
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function alreadyRunning(lock: LockInfo): Error {
  return new Error(
    `Сервис уже запущен (pid ${lock.pid}, порт ${lock.port}). ` +
      `Должен работать только ОДИН экземпляр. Остановите старый или используйте его.`,
  );
}

/**
 * Захватывает lock для сервиса. Если живой сервис уже есть — кидает ошибку
 * (нельзя два владельца сессии). Stale-lock перезаписывается. Создаётся АТОМАРНО
 * (open "wx" = O_CREAT|O_EXCL) с правами 600 — закрывает гонку двух одновременных
 * стартов и не светит токен другим пользователям. Возвращает токен/порт.
 */
export async function acquireLock(port: number): Promise<LockInfo> {
  const running = await serviceRunning();
  if (running) throw alreadyRunning(running);

  const info: LockInfo = { pid: process.pid, port, token: randomToken(), startedAt: new Date().toISOString() };
  const data = JSON.stringify(info, null, 2) + "\n";
  const path = lockPath();
  await mkdir(dirname(path), { recursive: true });

  const writeExclusive = async () => {
    const fh = await open(path, "wx", 0o600);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  };

  try {
    await writeExclusive();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    // lock появился между проверкой и созданием — это либо живой сервис, либо stale
    const again = await serviceRunning();
    if (again) throw alreadyRunning(again);
    await unlink(path).catch(() => {});
    await writeExclusive();
  }
  return info;
}

/** Снимает lock, только если он наш (по pid). */
export async function releaseLock(): Promise<void> {
  const lock = await readLock();
  if (lock && lock.pid === process.pid) await unlink(lockPath()).catch(() => {});
}
