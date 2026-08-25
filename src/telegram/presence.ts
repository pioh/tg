// Присутствие аккаунта: держим владельца «не в сети».
//
// Проблема: Telegram считает АКТИВНОСТЬЮ аккаунта любой RPC от его имени. Поэтому
// стоило сервису что-то сделать (проверка сессии на старте, опрос монитора, чтение
// истории по просьбе владельца) — владелец на несколько минут загорался «в сети»,
// хотя сам Telegram не открывал. Особенно заметно в 5–6 утра: ежедневный таймер
// обновления зависимостей перезапускает сервис, тот подключается — и вот он «онлайн».
//
// Решение: после КАЖДОГО запроса ставим короткий debounce-таймер и, когда активность
// утихла, явно сообщаем Telegram `account.updateStatus(offline: true)`. Окно «в сети»
// сжимается до пары секунд вместо ~5 минут.
//
// Перехват ставим на единственную воронку RPC — `client._client.call` (через неё идут
// и высокоуровневые методы mtcute, и сырой tg_api). Если внутренности mtcute
// изменятся и воронки не окажется — просто ничего не делаем (не ломаем сервис).
//
// Отключить: переменная окружения TG_KEEP_OFFLINE=0.

import type { TelegramClient } from "@mtcute/bun";

const UPDATE_STATUS = "account.updateStatus";
// Гасим статус практически сразу: цель — чтобы контакты не успели увидеть «в сети».
// Небольшой debounce нужен только чтобы склеить пачку запросов в один updateStatus.
const DEFAULT_DELAY_MS = Number(process.env.TG_OFFLINE_DEBOUNCE_MS ?? 250);
// После (пере)подключения mtcute шлёт updates.getState МИМО воронки call (это сетевой
// слой), поэтому гасим статус ещё и по событию соединения.
const AFTER_CONNECT_MS = 400;

type RawCall = (...args: unknown[]) => Promise<unknown>;
interface CallFunnel {
  call: RawCall;
  onConnectionState?: { add?: (cb: (state: string) => void) => void };
}

export function keepOfflineDisabled(): boolean {
  return String(process.env.TG_KEEP_OFFLINE ?? "1").trim() === "0";
}

// Время последнего РЕАЛЬНОГО запроса к Telegram (по воронке call). Нужно сервису, чтобы
// понять, что активности нет и от аккаунта можно отключиться совсем.
const lastRpc = new WeakMap<object, number>();

function funnelOf(tg: TelegramClient): CallFunnel | undefined {
  return (tg as unknown as { _client?: CallFunnel })._client;
}

/** Момент последнего запроса к Telegram (мс) или 0, если запросов не было. */
export function lastRpcAt(tg: TelegramClient): number {
  const f = funnelOf(tg);
  return f ? (lastRpc.get(f) ?? 0) : 0;
}

/** Подключён ли клиент к Telegram прямо сейчас. */
export function isConnected(tg: TelegramClient): boolean {
  return Boolean((funnelOf(tg) as { isConnected?: boolean } | undefined)?.isConnected);
}

/**
 * Включает авто-«оффлайн»: после затишья в запросах шлём account.updateStatus(offline).
 * Возвращает true, если перехват встал (false — воронку не нашли или выключено).
 */
export function keepAccountOffline(tg: TelegramClient, delayMs = DEFAULT_DELAY_MS): boolean {
  if (keepOfflineDisabled()) return false;
  const funnel = (tg as unknown as { _client?: CallFunnel })._client;
  if (!funnel || typeof funnel.call !== "function") return false;
  if ((funnel as { __tgOfflinePatched?: boolean }).__tgOfflinePatched) return true;

  const origCall = funnel.call.bind(funnel);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;

  const goOffline = (): void => {
    timer = undefined;
    if (inFlight) return;
    inFlight = true;
    origCall({ _: UPDATE_STATUS, offline: true })
      .catch(() => {}) // сеть/лимиты — не важно, попробуем после следующей активности
      .finally(() => {
        inFlight = false;
      });
  };

  funnel.call = (...args: unknown[]): Promise<unknown> => {
    const method = (args[0] as { _?: string } | undefined)?._;
    const res = origCall(...args);
    // Сам updateStatus активностью не считаем — иначе таймер перезаводил бы сам себя.
    if (method !== UPDATE_STATUS) {
      lastRpc.set(funnel, Date.now());
      if (timer) clearTimeout(timer);
      timer = setTimeout(goOffline, delayMs);
      (timer as { unref?: () => void }).unref?.();
    }
    return res;
  };
  // Переподключение: mtcute сам шлёт updates.getState в обход воронки call, и Telegram
  // может засчитать это активностью. Ловим событие соединения и гасим статус.
  funnel.onConnectionState?.add?.((state: string) => {
    if (state !== "connected" && state !== "updating") return;
    const t = setTimeout(goOffline, AFTER_CONNECT_MS);
    (t as { unref?: () => void }).unref?.();
  });

  // Жёсткий режим (по желанию владельца): раз в N секунд подтверждаем «оффлайн», даже
  // если своих запросов не было. Ловит любые всплески, которые прошли мимо воронки.
  // Побочка: пока режим включён, владелец будет выглядеть оффлайн И когда сам сидит
  // в Telegram с телефона. Поэтому по умолчанию выключено (0).
  const hbSec = Number(process.env.TG_OFFLINE_HEARTBEAT_SEC ?? 0);
  if (Number.isFinite(hbSec) && hbSec > 0) {
    const iv = setInterval(goOffline, hbSec * 1000);
    (iv as { unref?: () => void }).unref?.();
  }

  (funnel as { __tgOfflinePatched?: boolean }).__tgOfflinePatched = true;
  return true;
}

/** Сразу сказать Telegram «я не в сети» (например, сразу после подключения). */
export async function markOfflineNow(tg: TelegramClient): Promise<void> {
  if (keepOfflineDisabled()) return;
  await tg.setOnline(false).catch(() => {});
}
