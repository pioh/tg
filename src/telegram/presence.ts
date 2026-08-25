// Присутствие аккаунта: не даём владельцу «гореть» в сети из-за работы агента.
//
// ЧТО ИЗМЕРЕНО (эксперимент 2026-08-25, сервис с TG_KEEP_OFFLINE=0, статус читался
// через users.getUsers(inputUserSelf) после каждого шага):
//   • connect + updates.getState + users.getUsers → userStatusOffline, метка «был в
//     сети» НЕ сдвинулась;
//   • messages.getHistory → тоже offline, метка не сдвинулась;
//   • messages.getDialogs (полный список диалогов) → тоже offline;
//   • messages.sendMessage → userStatusOnline, expires = now + ~300с (5 минут!);
//   • account.updateStatus(offline:true) → статус гаснет мгновенно.
// Вывод: онлайн зажигает НЕ любой запрос, а ДЕЙСТВИЕ (отправка/правка/удаление
// сообщения, отметка прочитанным, «печатает…»). Чтение — бесплатное и невидимое.
//
// Поэтому гасим статус ТОЛЬКО после действий (writeMethod). Гасить после чтения не
// просто бесполезно — вредно: updateStatus(offline) затирает НАСТОЯЩИЙ онлайн
// владельца, если он в этот момент сам сидит в Telegram с телефона.
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

// Методы, после которых Telegram реально зажигает «в сети» (проверено экспериментом:
// сама отправка сообщения даёт userStatusOnline на ~5 минут). Всё остальное — чтение,
// оно статус не трогает, и гасить после него НЕ надо.
const WRITE_RE =
  /^(messages\.(send|forward|edit|delete|read|setTyping|saveDraft|sendReaction|sendMedia|sendMultiMedia|sendVote|startBot|getBotCallbackAnswer|setEncryptedTyping)|account\.(updateProfile|updateUsername|updateStatus)|folders\.|contacts\.(addContact|deleteContacts|block|unblock)|channels\.(readHistory|joinChannel|leaveChannel|editMessage|deleteMessages)|photos\.(uploadProfilePhoto|deletePhotos))/i;

export function isWriteMethod(method: string | undefined): boolean {
  return Boolean(method) && WRITE_RE.test(String(method));
}

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
    if (method !== UPDATE_STATUS) lastRpc.set(funnel, Date.now());
    // Гасим ТОЛЬКО после действий: чтение статус не зажигает (проверено), а лишний
    // updateStatus(offline) затирал бы настоящий онлайн владельца с его телефона.
    if (isWriteMethod(method)) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(goOffline, delayMs);
      (timer as { unref?: () => void }).unref?.();
    }
    return res;
  };

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
