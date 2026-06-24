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
import { createCodexEngine } from "./codex.ts";

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
      permissionMode: "dontAsk",
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
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "mcp__telegram"],
      disallowedTools: ["Bash"],
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id;
        } else if (m.type === "assistant") {
          for (const b of m.message.content) {
            if (b.type === "text") {
              log("claude:", b.text.slice(0, 400));
              opts.onText?.(b.text);
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
          if (r.text) opts.onText?.(r.text);
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
