// Внутреннее состояние сервиса (data/state.json): курсоры опроса и пр.
// Это НЕ память агента (та — в handoff/progress/qa), а технические метки.

import { STATE_PATH } from "./paths.ts";
import { atomicWriteJson } from "./atomic.ts";

export interface AgentUsage {
  turns: number;
  /** размер контекста на последнем ходу (≈ текущий контекст), input-токены. */
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  startedAt: string;
}

export interface ServiceState {
  /** id последнего обработанного сообщения в управляющем канале (по чату). */
  controlCursor: Record<string, number>;
  /** offset getUpdates сервисного бота. */
  botUpdateOffset?: number;
  /** id текущей сессии агента (продолжается между событиями и рестартами). */
  agentSessionId?: string;
  /** id треда Codex (для непрерывной сессии движка codex; resume при рестарте). */
  codexThreadId?: string;
  /** накопленный расход текущей сессии агента. */
  agentUsage?: AgentUsage;
  /** версия, про которую уже уведомили владельца (чтобы не спамить про обновление). */
  notifiedUpdateVersion?: string;
}

const EMPTY: ServiceState = { controlCursor: {} };

export async function loadState(): Promise<ServiceState> {
  const file = Bun.file(STATE_PATH);
  if (!(await file.exists())) return structuredClone(EMPTY);
  try {
    return { ...EMPTY, ...((await file.json()) as Partial<ServiceState>) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function saveState(state: ServiceState): Promise<void> {
  await atomicWriteJson(STATE_PATH, state);
}

// Сериализуем read-modify-write по state.json. Без этого два параллельных цикла
// сервиса (bot long-poll меняет botUpdateOffset; детектор — controlCursor; ходы —
// agentUsage) делали load→modify→save целого файла и затирали чужие поля
// (lost-update → дубли/потеря сообщений). updateState гарантирует: каждый мутатор
// получает СВЕЖИЙ state, меняет своё поле и сохраняет — строго по очереди.
let stateGate: Promise<unknown> = Promise.resolve();
export async function updateState<T>(mutator: (s: ServiceState) => T | Promise<T>): Promise<T> {
  const run = stateGate.then(async () => {
    const s = await loadState();
    const r = await mutator(s);
    await saveState(s);
    return r;
  });
  stateGate = run.then(
    () => {},
    () => {},
  );
  return run as Promise<T>;
}
