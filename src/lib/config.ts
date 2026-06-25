// Конфигурация. Источники по приоритету: переменные окружения -> data/config.json
// -> значения по умолчанию. Bun автоматически загружает .env, поэтому переменные
// можно держать и там (см. CLAUDE.md проекта — dotenv не нужен).

import { configPath } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

export type AgentEngine = "claude" | "codex";

export const ENGINES: readonly AgentEngine[] = ["claude", "codex"] as const;

// У движков РАЗНЫЕ наборы уровней усилия:
//   Claude: low|medium|high|xhigh|max
//   Codex:  minimal|low|medium|high|xhigh (нет "max")
// EFFORT_LEVELS — объединение (для хранения в конфиге), normalizeEffort валидирует
// под конкретный движок.
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEngine(v: unknown): v is AgentEngine {
  return v === "claude" || v === "codex";
}

/** Приводит уровень усилия к валидному для движка значению или бросает понятную ошибку. */
export function normalizeEffort(v: string, engine: AgentEngine = "claude"): EffortLevel {
  const e = v.trim().toLowerCase();
  const allowed = (engine === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS) as readonly string[];
  if (allowed.includes(e)) return e as EffortLevel;
  throw new Error(`Неверный effort "${v}" для движка ${engine}. Допустимо: ${allowed.join(", ")}.`);
}

export interface Config {
  /** api_id приложения с https://my.telegram.org */
  apiId: number;
  /** api_hash приложения с https://my.telegram.org */
  apiHash: string;
  /**
   * Управляющий канал — откуда агент берёт команды человека.
   * "me"/"self" = «Избранное» (Saved Messages). Можно указать @username или id.
   */
  controlChat: string;
  /** Какой движок запускать сервисом по умолчанию. */
  agent: AgentEngine;
  /** Модель для движка (например "opus"). */
  model: string;
  /** Уровень reasoning-усилия: low|medium|high|xhigh|max (опц.). */
  effort?: string;
  /** Интервал тика сервиса, секунды. */
  intervalSeconds: number;
  /** Токен сервисного Telegram-бота (от BotFather). */
  botToken?: string;
  /** @username сервисного бота. */
  botUsername?: string;
  /** chat_id владельца в переписке с ботом (куда бот пишет проактивно). */
  botOwnerChatId?: number;
  /** chat_id «ассистент-группы» (семья): там бот отвечает на ВСЕ сообщения разрешённых
   *  участников. Назначается командой /here в группе. Требует выключенного privacy-mode. */
  botGroupChatId?: number;
}

// Встроенные api_id/api_hash (как в исходной заготовке base.js) — чтобы `login`
// работал сразу, без вопросов. Это публичные/общие креды приложения Telegram.
// Хотите свои — задайте TG_API_ID/TG_API_HASH или впишите в data/config.json
// (свои креды надёжнее и снижают риск общих лимитов/блокировок).
const DEFAULT_API_ID = 25282;
const DEFAULT_API_HASH = "b334f72ad1a3d4e3324894ccde2d2dab";

const DEFAULTS: Omit<Config, "apiId" | "apiHash"> = {
  controlChat: "me",
  agent: "claude",
  model: "opus",
  intervalSeconds: 60,
};

async function readFileConfig(): Promise<Partial<Config>> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return {};
  try {
    return (await file.json()) as Partial<Config>;
  } catch {
    return {};
  }
}

/** Конфиг как он ЗАПИСАН в файле (без наложения env). Нужно там, где важно сравнить с
 *  персистентным значением, а не с effective (например, сменился ли токен бота на диске —
 *  effective мог быть перекрыт TG_BOT_TOKEN). */
export async function loadFileConfig(): Promise<Partial<Config>> {
  return readFileConfig();
}

/** Полная конфигурация с учётом env и файла. apiId/apiHash могут быть undefined. */
export async function loadConfig(): Promise<Partial<Config>> {
  const f = await readFileConfig();
  const apiIdEnv = process.env.TG_API_ID ? Number(process.env.TG_API_ID) : undefined;
  const apiId = Number.isFinite(apiIdEnv) ? apiIdEnv : (f.apiId ?? DEFAULT_API_ID);
  const apiHash = process.env.TG_API_HASH ?? f.apiHash ?? DEFAULT_API_HASH;
  const agentEnv = isEngine(process.env.TG_AGENT) ? process.env.TG_AGENT : undefined;
  const fileAgent = isEngine(f.agent) ? f.agent : undefined;
  const fileEffort = f.effort && (EFFORT_LEVELS as readonly string[]).includes(f.effort.toLowerCase())
    ? (f.effort.toLowerCase() as EffortLevel)
    : undefined;
  const envEffort = process.env.TG_EFFORT && (EFFORT_LEVELS as readonly string[]).includes(process.env.TG_EFFORT.toLowerCase())
    ? (process.env.TG_EFFORT.toLowerCase() as EffortLevel)
    : undefined;
  const intervalEnv = process.env.TG_INTERVAL ? Number(process.env.TG_INTERVAL) : undefined;
  const intervalSeconds =
    Number.isFinite(intervalEnv) && (intervalEnv as number) > 0
      ? (intervalEnv as number)
      : (f.intervalSeconds ?? DEFAULTS.intervalSeconds);
  return {
    apiId,
    apiHash,
    controlChat: process.env.TG_CONTROL_CHAT ?? f.controlChat ?? DEFAULTS.controlChat,
    agent: agentEnv ?? fileAgent ?? DEFAULTS.agent,
    model: process.env.TG_MODEL ?? f.model ?? DEFAULTS.model,
    intervalSeconds,
    effort: envEffort ?? fileEffort,
    botToken: process.env.TG_BOT_TOKEN ?? f.botToken,
    botUsername: f.botUsername,
    botOwnerChatId: f.botOwnerChatId,
    botGroupChatId: f.botGroupChatId,
  };
}

/** Требует наличия api-кредов, иначе кидает понятную ошибку. */
export async function requireConfig(): Promise<Config> {
  const c = await loadConfig();
  if (!c.apiId || !c.apiHash) {
    throw new Error(
      "Нет API-кредов Telegram. Запустите `bun run tg login <имя>` (или задайте TG_API_ID/TG_API_HASH).",
    );
  }
  return c as Config;
}

/** Дописывает/обновляет поля в data/config.json (мержит с существующим).
 *  Сериализуется, чтобы параллельные вызовы (/model, /effort, привязка чата бота) не
 *  затирали друг друга (lost-update read-modify-write на одном файле). */
let configGate: Promise<unknown> = Promise.resolve();
export async function saveConfig(patch: Partial<Config>): Promise<void> {
  const run = configGate.then(async () => {
    const existing = await readFileConfig();
    await atomicWriteJson(configPath(), { ...existing, ...patch });
  });
  configGate = run.then(
    () => {},
    () => {},
  );
  return run;
}
