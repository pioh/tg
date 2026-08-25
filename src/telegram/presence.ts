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
const DEFAULT_DELAY_MS = 3000;

type RawCall = (...args: unknown[]) => Promise<unknown>;
interface CallFunnel {
  call: RawCall;
}

export function keepOfflineDisabled(): boolean {
  return String(process.env.TG_KEEP_OFFLINE ?? "1").trim() === "0";
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
      if (timer) clearTimeout(timer);
      timer = setTimeout(goOffline, delayMs);
      (timer as { unref?: () => void }).unref?.();
    }
    return res;
  };
  (funnel as { __tgOfflinePatched?: boolean }).__tgOfflinePatched = true;
  return true;
}

/** Сразу сказать Telegram «я не в сети» (например, сразу после подключения). */
export async function markOfflineNow(tg: TelegramClient): Promise<void> {
  if (keepOfflineDisabled()) return;
  await tg.setOnline(false).catch(() => {});
}
