// Живая сессия агента. Сообщения/события докидываются НА ЛЕТУ (streaming input) —
// не дожидаясь конца текущего хода: push() кладёт сообщение в очередь, SDK берёт его
// следующим в той же непрерывной сессии. Так новые указания человека сразу попадают
// в текущий контекст агента.
//
// claude: настоящий streaming (@anthropic-ai/claude-agent-sdk, prompt = AsyncIterable).
// codex: последовательные ходы из очереди в НЕПРЕРЫВНОМ треде (resume по threadId).
//
// Если сессия неожиданно умирает — вызывается onError, и сервис перезапускает её с
// resume (watchdog). См. service.ts.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { REPO_ROOT, MCP_SERVER_PATH } from "../lib/paths.ts";
import { log } from "../lib/log.ts";
import { redact } from "../lib/redact.ts";
import { createCodexEngine } from "./codex.ts";

// ---- Читаемый трейс хода агента (мысли/вызовы тулов/результаты) в журнал ----
// Форматируем в человекочитаемый вид (НЕ сырой JSON), секреты маскируем (redact),
// длинные значения обрезаем. Лимит на строку — TG_TRACE_MAX (по умолчанию 2000).
const TRACE_MAX = Math.max(200, Number(process.env.TG_TRACE_MAX ?? 2000));
function clip(s: string, max = TRACE_MAX): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
function fmtVal(v: unknown): string {
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  if (v === null || v === undefined || typeof v !== "object") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "?";
  }
}
/** Аргументы вызова инструмента в виде `key=value, key=value` (не JSON), с маскировкой. */
function fmtArgs(input: unknown): string {
  const red = redact(input);
  if (!red || typeof red !== "object" || Array.isArray(red)) return fmtVal(red);
  return Object.entries(red as Record<string, unknown>)
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join(", ");
}
/** Результат инструмента коротко и читаемо (текст/`[image]`/…), с маскировкой. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmtToolResult(b: any): string {
  const c = redact(b?.content);
  let s: string;
  if (typeof c === "string") s = c;
  else if (Array.isArray(c))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s = c.map((x: any) => (x?.type === "text" ? x.text : x?.type === "image" ? "[image]" : (x?.type ?? ""))).join(" ");
  else s = String(c ?? "");
  return (b?.is_error ? "❌ " : "") + clip(s, 400);
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionOpts {
  engine: "claude" | "codex";
  model: string;
  effort?: string;
  append: string;
  resume?: string;
  hubPort: number;
  hubToken: string;
  /** threadId для движка codex (непрерывность между рестартами). */
  codexResumeThreadId?: string;
  onText?: (text: string) => void;
  /** Читаемый трейс хода агента (мысли/вызовы тулов/результаты) — в журнал сервиса. */
  trace?: (line: string) => void;
  onTurnEnd?: (usage: TurnUsage, sessionId: string | undefined, queueEmpty: boolean) => void;
  /** codex: сообщить актуальный threadId для сохранения на диск. */
  onThreadId?: (threadId: string) => void;
  /** сессия неожиданно завершилась/упала — сервис перезапустит её с resume. */
  onError?: (err: unknown) => void;
}

export interface AgentSession {
  push(content: string): void;
  setModel(model: string): void;
  getSessionId(): string | undefined;
  close(): Promise<void>;
}

// Очередь с ожиданием: push не блокирует; итератор отдаёт элементы по мере поступления.
class WaitQueue {
  private items: string[] = [];
  private waiter: ((v: string | null) => void) | null = null;
  private closed = false;
  get size(): number {
    return this.items.length;
  }
  push(x: string): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(x);
    } else this.items.push(x);
  }
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
  async *iter(): AsyncGenerator<string> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const v = await new Promise<string | null>((res) => (this.waiter = res));
      if (v === null) return;
      yield v;
    }
  }
}

function createClaudeSession(opts: SessionOpts): AgentSession {
  const queue = new WaitQueue();
  let sessionId = opts.resume;
  let closed = false;
  const trace = (line: string): void => (opts.trace ? opts.trace(line) : log(line));
  const toolNames = new Map<string, string>(); // tool_use_id → имя инструмента (для результатов)
  let thinkingBuf = ""; // накопитель thinking_delta (текст мысли идёт частями)
  let inThinking = false;

  async function* input(): AsyncGenerator<SDKUserMessage> {
    for await (const content of queue.iter()) {
      yield { type: "user", message: { role: "user", content } } as SDKUserMessage;
    }
  }

  const q = query({
    prompt: input(),
    options: {
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      cwd: REPO_ROOT,
      // Полные права без подтверждений (как Claude Code с --dangerously-skip-permissions):
      // все инструменты, включая Bash. Это личный локальный инструмент владельца.
      permissionMode: "bypassPermissions",
      // В streaming-режиме (prompt = AsyncIterable) блоки thinking НЕ попадают в
      // консолидированное assistant-сообщение без этого флага — включаем, чтобы мысли
      // агента были видны в трейсе журнала. Частичные stream_event-события игнорируем.
      includePartialMessages: true,
      settingSources: [],
      ...(opts.resume ? { resume: opts.resume } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: opts.append },
      mcpServers: {
        telegram: {
          type: "stdio",
          command: "bun",
          args: ["run", MCP_SERVER_PATH],
          env: { TG_HUB_PORT: String(opts.hubPort), TG_HUB_TOKEN: opts.hubToken },
        },
      },
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id;
        } else if (m.type === "stream_event") {
          // В streaming-режиме ТЕКСТ мысли (thinking) приходит только частичными
          // дельтами — копим их и выводим 💭 по завершении блока (в консолидированном
          // assistant thinking-текст пустой). Текстовые дельты игнорируем — готовый текст
          // берём из assistant-сообщения ниже.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ev = (m as any).event;
          if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
            inThinking = true;
            thinkingBuf = "";
          } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
            thinkingBuf += ev.delta.thinking ?? "";
          } else if (ev?.type === "content_block_stop" && inThinking) {
            if (thinkingBuf.trim()) trace(`💭 ${clip(thinkingBuf)}`);
            inThinking = false;
            thinkingBuf = "";
          }
        } else if (m.type === "assistant") {
          // Текст ответа и вызовы инструментов (мысли — через stream_event выше).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const b of m.message.content as any[]) {
            if (b.type === "text") {
              trace(`💬 ${clip(b.text)}`);
              opts.onText?.(b.text);
            } else if (b.type === "tool_use") {
              if (b.id && b.name) toolNames.set(b.id, b.name);
              trace(`🔧 ${b.name}(${fmtArgs(b.input)})`);
            }
          }
        } else if (m.type === "user") {
          // Результаты инструментов приходят как user-сообщение с блоками tool_result.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const content = (m as any).message?.content;
          if (Array.isArray(content)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const b of content as any[]) {
              if (b?.type === "tool_result") {
                const name = toolNames.get(b.tool_use_id) ?? "tool";
                trace(`↳ ${name}: ${fmtToolResult(b)}`);
              }
            }
          }
        } else if (m.type === "result") {
          if (m.session_id) sessionId = m.session_id;
          const u = (m.usage ?? {}) as {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          opts.onTurnEnd?.(
            {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
              costUsd: m.total_cost_usd ?? 0,
            },
            sessionId,
            queue.size === 0,
          );
        }
      }
      if (!closed) opts.onError?.(new Error("claude-сессия завершилась неожиданно"));
    } catch (e) {
      log("сессия claude завершилась:", e instanceof Error ? e.message : e);
      if (!closed) opts.onError?.(e);
    }
  })();

  return {
    push: (c) => queue.push(c),
    setModel: (mdl) => {
      try {
        (q as { setModel?: (m: string) => void }).setModel?.(mdl);
      } catch (e) {
        log("setModel:", e instanceof Error ? e.message : e);
      }
    },
    getSessionId: () => sessionId,
    close: async () => {
      closed = true;
      try {
        (q as { interrupt?: () => void }).interrupt?.();
      } catch {
        /* ignore */
      }
      queue.close();
    },
  };
}

function createCodexSession(opts: SessionOpts): AgentSession {
  const queue = new WaitQueue();
  let threadId = opts.codexResumeThreadId;
  let closed = false;

  (async () => {
    try {
      const engine = await createCodexEngine({
        model: opts.model,
        effort: opts.effort,
        append: opts.append,
        hubPort: opts.hubPort,
        hubToken: opts.hubToken,
        resumeThreadId: opts.codexResumeThreadId,
      });
      let consecErrors = 0;
      for await (const content of queue.iter()) {
        try {
          const r = await engine.run(content);
          consecErrors = 0;
          if (r.threadId && r.threadId !== threadId) {
            threadId = r.threadId;
            opts.onThreadId?.(r.threadId);
          }
          if (r.text) {
            opts.trace?.(`💬 ${clip(r.text)}`);
            opts.onText?.(r.text);
          }
          opts.onTurnEnd?.(r.usage, threadId, queue.size === 0);
        } catch (e) {
          consecErrors++;
          log("codex turn:", e instanceof Error ? e.message : e);
          opts.onTurnEnd?.(
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
            threadId,
            queue.size === 0,
          );
          // Несколько ошибок подряд — эскалируем в watchdog (перезапуск с resume).
          if (consecErrors >= 3 && !closed) {
            opts.onError?.(e);
            break;
          }
        }
      }
    } catch (e) {
      if (!closed) opts.onError?.(e);
    }
  })();

  return {
    push: (c) => queue.push(c),
    setModel: () => {},
    getSessionId: () => threadId,
    close: async () => {
      closed = true;
      queue.close();
    },
  };
}

export function createAgentSession(opts: SessionOpts): AgentSession {
  return opts.engine === "codex" ? createCodexSession(opts) : createClaudeSession(opts);
}
