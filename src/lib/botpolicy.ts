// Политика реакции бота в топике — «на что реагировать, а на что нет», настраивается
// самим агентом (bot_policy_get/bot_policy_set). Применяется в topic-режиме к ОБЫЧНОМУ
// тексту (не к командам): решает, будить ли агента на сообщение. Так топик-бот может
// быть избирательным (только на ключевые слова, только при упоминании, игнор ботов и
// конкретных людей, троттлинг), не поднимая агента на каждый чих.
//
// Хранилище: data/bot-policy.json = { policy, lastReactAt? }.

import { botPolicyPath } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

export interface BotPolicy {
  /** Кого слушать: "all" — всех участников топика; "owner" — только владельца аккаунта;
   *  массив id — только указанных пользователей. */
  reactTo: "all" | "owner" | number[];
  /** Никогда не реагировать на этих пользователей (id). */
  ignoreUserIds: number[];
  /** Если непусто — реагировать ТОЛЬКО когда текст содержит одно из этих слов. */
  keywordsAny: string[];
  /** Если текст содержит одно из этих слов — игнорировать. */
  excludeKeywords: string[];
  /** Реагировать только если бот явно @упомянут в тексте. */
  mentionOnly: boolean;
  /** Игнорировать сообщения от ботов (защита от петель бот↔бот). */
  ignoreBots: boolean;
  /** Не чаще одной реакции в N секунд (0 = без троттлинга). */
  minIntervalSec: number;
}

export const DEFAULT_POLICY: BotPolicy = {
  reactTo: "all",
  ignoreUserIds: [],
  keywordsAny: [],
  excludeKeywords: [],
  mentionOnly: false,
  ignoreBots: true,
  minIntervalSec: 0,
};

interface PolicyFile {
  policy: BotPolicy;
  lastReactAt?: number;
}

/** Сообщение, к которому применяется политика (подмножество BotIncoming). */
export interface PolicyMsg {
  fromId: number;
  isOwner: boolean;
  fromIsBot: boolean;
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePolicy(raw: any): BotPolicy {
  const r = raw && typeof raw === "object" ? raw : {};
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x) => typeof x === "number") : []);
  const reactTo: BotPolicy["reactTo"] =
    r.reactTo === "owner" || r.reactTo === "all" ? r.reactTo : Array.isArray(r.reactTo) ? numArr(r.reactTo) : "all";
  return {
    reactTo,
    ignoreUserIds: numArr(r.ignoreUserIds),
    keywordsAny: strArr(r.keywordsAny),
    excludeKeywords: strArr(r.excludeKeywords),
    mentionOnly: r.mentionOnly === true,
    ignoreBots: r.ignoreBots === false ? false : true,
    minIntervalSec: typeof r.minIntervalSec === "number" && r.minIntervalSec > 0 ? r.minIntervalSec : 0,
  };
}

async function loadFile(): Promise<PolicyFile> {
  const f = Bun.file(botPolicyPath());
  if (!(await f.exists())) return { policy: { ...DEFAULT_POLICY } };
  try {
    const raw = (await f.json()) as Partial<PolicyFile>;
    return { policy: normalizePolicy(raw.policy), lastReactAt: typeof raw.lastReactAt === "number" ? raw.lastReactAt : undefined };
  } catch {
    return { policy: { ...DEFAULT_POLICY } };
  }
}

async function saveFile(data: PolicyFile): Promise<void> {
  await atomicWriteJson(botPolicyPath(), data);
}

/** Текущая политика (с дефолтами). */
export async function getPolicy(): Promise<BotPolicy> {
  return (await loadFile()).policy;
}

/** Частично обновить политику (мерж с текущей). undefined-поля патча игнорируются, чтобы
 *  не сбрасывать существующие значения к дефолтам. Возвращает итоговую политику. */
export async function setPolicy(patch: Partial<BotPolicy>): Promise<BotPolicy> {
  const file = await loadFile();
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = normalizePolicy({ ...file.policy, ...clean });
  await saveFile({ ...file, policy: merged });
  return merged;
}

/**
 * Чистое решение: реагировать ли на сообщение по политике. Без побочных эффектов —
 * удобно для тестов. lastReactAt — время последней реакции (для троттлинга).
 */
export function evaluatePolicy(
  m: PolicyMsg,
  policy: BotPolicy,
  botUsername: string | undefined,
  nowMs: number,
  lastReactAt: number | undefined,
): { react: boolean; reason: string } {
  if (policy.ignoreBots && m.fromIsBot) return { react: false, reason: "bot" };
  if (policy.ignoreUserIds.includes(m.fromId)) return { react: false, reason: "ignored-user" };
  if (policy.reactTo === "owner" && !m.isOwner) return { react: false, reason: "not-owner" };
  if (Array.isArray(policy.reactTo) && !policy.reactTo.includes(m.fromId)) return { react: false, reason: "not-in-reactTo" };
  const lower = m.text.toLowerCase();
  if (policy.mentionOnly) {
    const uname = (botUsername ?? "").toLowerCase();
    if (!uname || !lower.includes("@" + uname)) return { react: false, reason: "no-mention" };
  }
  if (policy.excludeKeywords.length && policy.excludeKeywords.some((k) => lower.includes(k.toLowerCase()))) {
    return { react: false, reason: "excluded-keyword" };
  }
  if (policy.keywordsAny.length && !policy.keywordsAny.some((k) => lower.includes(k.toLowerCase()))) {
    return { react: false, reason: "no-keyword" };
  }
  if (policy.minIntervalSec > 0 && lastReactAt && nowMs - lastReactAt < policy.minIntervalSec * 1000) {
    return { react: false, reason: "throttled" };
  }
  return { react: true, reason: "ok" };
}

/**
 * Решить, реагировать ли (с учётом персистентного троттлинга). При положительном
 * решении и заданном minIntervalSec фиксирует lastReactAt на диске.
 */
export async function shouldReact(m: PolicyMsg, botUsername: string | undefined, nowMs: number): Promise<{ react: boolean; reason: string }> {
  const file = await loadFile();
  const res = evaluatePolicy(m, file.policy, botUsername, nowMs, file.lastReactAt);
  if (res.react && file.policy.minIntervalSec > 0) {
    await saveFile({ ...file, lastReactAt: nowMs });
  }
  return res;
}
