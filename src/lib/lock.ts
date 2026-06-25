// Один сервис — один владелец Telegram-сессии (на каждого тенанта). Здесь реализован
// процессный lock и рантайм-координаты хаба: pid, порт RPC и случайный bearer-токен.
// Файл лежит в рабочей папке ТЕКУЩЕГО тенанта: tenants/<имя>/service.lock (lockPath()),
// личные данные, не в git, пишется с правами 600.
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
// Сколько секунд считать lock «свежим» по pid, пока хаб ещё не отвечает (окно старта).
const LOCK_STARTUP_GRACE_MS = 60000;

export async function serviceRunning(): Promise<LockInfo | null> {
  const lock = await readLock();
  if (!lock) return null;
  // Надёжный признак «живой» — отвечает хаб на его порту.
  if (await hubHealthy(lock.port)) return lock;
  // Хаб не отвечает: считаем «запускается» ТОЛЬКО если pid жив И lock СВЕЖИЙ. Иначе это
  // stale (частый случай после ПЕРЕЗАГРУЗКИ: pid из lock переиспользован чужим процессом —
  // pidAlive=true, но это не наш сервис). Свежесть отсекает такие ложные срабатывания.
  const ageMs = Date.now() - Date.parse(lock.startedAt);
  if (pidAlive(lock.pid) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < LOCK_STARTUP_GRACE_MS) {
    return lock; // наш процесс ещё поднимает хаб
  }
  return null; // stale — можно перезахватить
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
 * Готовит координаты сервиса (pid/port/token), НЕ записывая lock на диск. Если живой
 * сервис уже есть — кидает ошибку (нельзя два владельца сессии). Используется, чтобы
 * получить токен ДО старта хаба, а сам lock записать только ПОСЛЕ успешного бинда
 * (writeLock) — иначе возникает окно, когда lock уже есть, а хаб ещё не слушает.
 */
export async function prepareLock(port: number): Promise<LockInfo> {
  const running = await serviceRunning();
  if (running) throw alreadyRunning(running);
  return { pid: process.pid, port, token: randomToken(), startedAt: new Date().toISOString() };
}

/**
 * Записывает lock АТОМАРНО (open "wx" = O_CREAT|O_EXCL) с правами 600 — закрывает гонку
 * двух одновременных стартов и не светит токен другим пользователям. Звать ПОСЛЕ того,
 * как хаб реально слушает порт (см. prepareLock): так потребитель никогда не схватит
 * lock с портом/токеном ещё не поднятого хаба.
 */
export async function writeLock(info: LockInfo): Promise<void> {
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
    // lock появился между prepareLock и записью — это либо живой сервис, либо stale.
    const again = await serviceRunning();
    if (again) throw alreadyRunning(again);
    await unlink(path).catch(() => {});
    await writeExclusive();
  }
}

/**
 * Захватывает lock для сервиса одним вызовом (проверка + запись). Оставлен для случаев,
 * где хаб поднимать не нужно. Когда поднимается хаб, используйте prepareLock + writeLock,
 * чтобы lock на диске появился только ПОСЛЕ успешного бинда.
 */
export async function acquireLock(port: number): Promise<LockInfo> {
  const info = await prepareLock(port);
  await writeLock(info);
  return info;
}

/** Снимает lock, только если он наш (по pid). */
export async function releaseLock(): Promise<void> {
  const lock = await readLock();
  if (lock && lock.pid === process.pid) await unlink(lockPath()).catch(() => {});
}
