// Мониторы — точечное наблюдение за конкретными чатами/топиками/людьми с триггерами.
//
// Идея: по умолчанию агент ПАССИВЕН. Реакция возникает только если человек явно
// попросил следить за чем-то — тогда агент создаёт монитор. На каждом тике сервис
// зовёт evaluateMonitors(): монитор «срабатывает» только когда выполнены его условия.
//
// Триггеры:
//   minIntervalSec       — срабатывать не чаще раза в N секунд (троттлинг);
//   onlyIfOwnerSilentSec — реагировать на сообщение, только если владелец сам НЕ
//                          ответил в этом чате и прошло уже N секунд (даём человеку
//                          шанс ответить первым).
// Фильтры match: fromUserId / keywords / mentionsMe — что считать значимым.
//
// Хранилище: data/monitors.json. Состояние (курсор/время срабатывания) живёт там же.

import type { TelegramClient, Message } from "@mtcute/bun";
import { monitorsPath } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";
import { messageLite, type MessageLite } from "../telegram/ops.ts";

export type MonitorAction = "notify" | "draft" | "reply";

export interface MonitorMatch {
  fromUserId?: number;
  keywords?: string[];
  mentionsMe?: boolean;
}

export interface Monitor {
  id: string;
  name: string;
  chat: string; // id / @username / username
  topicId?: number; // для форум-топиков
  match?: MonitorMatch;
  action: MonitorAction; // что делать при срабатывании (по правилам агента)
  minIntervalSec?: number;
  onlyIfOwnerSilentSec?: number;
  enabled: boolean;
  // состояние
  lastSeenMessageId: number;
  lastFiredAt?: number; // epoch ms
}

interface MonitorsFile {
  monitors: Monitor[];
}

function coerce(chatId: string): string | number {
  const s = chatId.trim();
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

const VALID_ACTIONS: readonly MonitorAction[] = ["notify", "draft", "reply"];

// Миграция/валидация одной записи: чинит мониторы, у которых из-за старого бага
// (запись undefined-полей) пропали обязательные enabled/action. Без этого монитор с
// enabled:undefined считался выключенным («почему не реагирует» — был именно тут).
function normalizeMonitor(raw: any): Monitor | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.chat !== "string") return null;
  const action: MonitorAction = VALID_ACTIONS.includes(raw.action) ? raw.action : "notify";
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    chat: raw.chat,
    topicId: typeof raw.topicId === "number" ? raw.topicId : undefined,
    match: raw.match && typeof raw.match === "object" ? raw.match : undefined,
    action,
    minIntervalSec: typeof raw.minIntervalSec === "number" ? raw.minIntervalSec : undefined,
    onlyIfOwnerSilentSec: typeof raw.onlyIfOwnerSilentSec === "number" ? raw.onlyIfOwnerSilentSec : undefined,
    enabled: raw.enabled === false ? false : true, // отсутствует/undefined → включён
    lastSeenMessageId: typeof raw.lastSeenMessageId === "number" ? raw.lastSeenMessageId : 0,
    lastFiredAt: typeof raw.lastFiredAt === "number" ? raw.lastFiredAt : undefined,
  };
}

async function load(): Promise<MonitorsFile> {
  const f = Bun.file(monitorsPath());
  if (!(await f.exists())) return { monitors: [] };
  try {
    const raw = (await f.json()) as Partial<MonitorsFile>;
    const list = Array.isArray(raw.monitors) ? raw.monitors : [];
    return { monitors: list.map(normalizeMonitor).filter((m): m is Monitor => m !== null) };
  } catch {
    return { monitors: [] };
  }
}

async function save(data: MonitorsFile): Promise<void> {
  await atomicWriteJson(monitorsPath(), data);
}

function newId(existing: Monitor[]): string {
  // детерминированный короткий id (без Math.random, недоступного здесь не требуется)
  let n = existing.length + 1;
  const ids = new Set(existing.map((m) => m.id));
  while (ids.has(`m${n}`)) n++;
  return `m${n}`;
}

export interface AddMonitorInput {
  name: string;
  chat: string;
  topicId?: number;
  match?: MonitorMatch;
  action?: MonitorAction;
  minIntervalSec?: number;
  onlyIfOwnerSilentSec?: number;
}

/** Создаёт монитор и ставит базовый курсор на текущее последнее сообщение
 *  (чтобы не сработать на всю старую историю). */
export async function addMonitor(tg: TelegramClient, input: AddMonitorInput): Promise<Monitor> {
  const data = await load();
  const peer = await tg.resolvePeer(coerce(input.chat));
  let baseline = 0;
  if (input.topicId != null) {
    const msgs = await tg.searchMessages({ chatId: peer, threadId: input.topicId, limit: 1 });
    baseline = msgs[0]?.id ?? 0;
  } else {
    const msgs = await tg.getHistory(peer, { limit: 1 });
    baseline = msgs[0]?.id ?? 0;
  }
  const monitor: Monitor = {
    id: newId(data.monitors),
    name: input.name,
    chat: input.chat,
    topicId: input.topicId,
    match: input.match,
    action: input.action ?? "notify",
    minIntervalSec: input.minIntervalSec,
    onlyIfOwnerSilentSec: input.onlyIfOwnerSilentSec,
    enabled: true,
    lastSeenMessageId: baseline,
  };
  data.monitors.push(monitor);
  await save(data);
  return monitor;
}

export async function listMonitors(): Promise<Monitor[]> {
  return (await load()).monitors;
}

export async function removeMonitor(id: string): Promise<boolean> {
  const data = await load();
  const before = data.monitors.length;
  data.monitors = data.monitors.filter((m) => m.id !== id);
  await save(data);
  return data.monitors.length < before;
}

export async function updateMonitor(id: string, patch: Partial<Monitor>): Promise<Monitor | null> {
  const data = await load();
  const m = data.monitors.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, patch, { id: m.id }); // id неизменяем
  await save(data);
  return m;
}

function matches(m: Message, meId: number, f?: MonitorMatch): boolean {
  if (!f) return true;
  if (f.fromUserId != null && m.sender?.id !== f.fromUserId) return false;
  if (f.mentionsMe && !(m.isMention || m.replyToMessage?.id != null)) return false;
  if (f.keywords && f.keywords.length > 0) {
    const text = (m.text ?? "").toLowerCase();
    if (!f.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  }
  // не реагируем на собственные сообщения владельца
  if (m.sender?.id === meId) return false;
  return true;
}

export interface FiredMonitor {
  monitorId: string;
  name: string;
  chat: string;
  topicId?: number;
  action: MonitorAction;
  messages: MessageLite[];
}

/**
 * Оценивает все включённые мониторы. Возвращает только сработавшие (с новыми
 * значимыми сообщениями, прошедшими троттлинг и проверку «владелец молчит»).
 * Двигает курсоры и фиксирует время срабатывания на диске.
 */
export async function evaluateMonitors(tg: TelegramClient, nowMs: number): Promise<FiredMonitor[]> {
  const data = await load();
  if (data.monitors.length === 0) return [];
  const meId = (await tg.getMe()).id;
  const fired: FiredMonitor[] = [];
  let changed = false;

  for (const mon of data.monitors) {
    if (!mon.enabled) continue;

    // Троттлинг: если недавно срабатывал — пропускаем без изменения курсора.
    if (mon.minIntervalSec && mon.lastFiredAt && nowMs - mon.lastFiredAt < mon.minIntervalSec * 1000) {
      continue;
    }

    const peer = await tg.resolvePeer(coerce(mon.chat));
    const raw =
      mon.topicId != null
        ? await tg.searchMessages({ chatId: peer, threadId: mon.topicId, minId: mon.lastSeenMessageId, limit: 100 })
        : await tg.getHistory(peer, { minId: mon.lastSeenMessageId, limit: 100 });

    const fresh = [...raw].filter((m) => m.id > mon.lastSeenMessageId).sort((a, b) => a.id - b.id);
    if (fresh.length === 0) continue;

    // Последнее исходящее (владельца) — для проверки «человек уже ответил».
    let ownerOutgoingMaxDate = 0;
    for (const m of fresh) {
      if (m.isOutgoing || m.sender?.id === meId) ownerOutgoingMaxDate = Math.max(ownerOutgoingMaxDate, m.date.getTime());
    }

    const toFire: Message[] = [];
    let cursor = mon.lastSeenMessageId;
    let pending = false;

    for (const m of fresh) {
      if (!matches(m, meId, mon.match)) {
        cursor = m.id; // не интересно — потребляем
        continue;
      }
      const ownerRepliedAfter = ownerOutgoingMaxDate > m.date.getTime();
      if (mon.onlyIfOwnerSilentSec != null) {
        if (ownerRepliedAfter) {
          cursor = m.id; // человек уже ответил — пропускаем
          continue;
        }
        if (nowMs - m.date.getTime() < mon.onlyIfOwnerSilentSec * 1000) {
          pending = true; // ещё рано — ждём, курсор НЕ двигаем дальше этого сообщения
          break;
        }
      } else if (ownerRepliedAfter) {
        cursor = m.id; // без правила тишины: если уже ответили — тоже пропускаем
        continue;
      }
      toFire.push(m);
      cursor = m.id;
    }

    if (cursor !== mon.lastSeenMessageId) {
      mon.lastSeenMessageId = cursor;
      changed = true;
    }
    if (toFire.length > 0) {
      mon.lastFiredAt = nowMs;
      changed = true;
      fired.push({
        monitorId: mon.id,
        name: mon.name,
        chat: mon.chat,
        topicId: mon.topicId,
        action: mon.action,
        messages: toFire.map(messageLite),
      });
    }
    void pending;
  }

  if (changed) await save(data);
  return fired;
}
