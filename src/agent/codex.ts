// Движок OpenAI Codex (@openai/codex-sdk) — НЕПРЕРЫВНЫЙ thread.
//
// Раньше каждый ход создавал новый Codex и новый thread → терялась память разговора.
// Теперь thread создаётся один раз (или восстанавливается по threadId через resume),
// и каждый ход — это thread.run() в том же треде. ThreadId сохраняется на диске
// (data/state.json) и переживает рестарт сервиса. См. ревью п.7.
//
// Аутентификация: `codex login` (подписка ChatGPT) или OPENAI_API_KEY. MCP-сервер
// "telegram" регистрируется программно (тот же, что у Claude) с bearer-токеном хаба.
//
// Если SDK недоступен — деградация на CLI `codex exec` (по ходу за раз, БЕЗ
// непрерывности треда). Это честно отражено в README (engine matrix).

import { REPO_ROOT, MCP_SERVER_PATH } from "../lib/paths.ts";
import { log, warn } from "../lib/log.ts";
import type { TurnUsage } from "./session.ts";

export interface CodexRunResult {
  text: string;
  threadId?: string;
  usage: TurnUsage;
}

export interface CodexEngine {
  run(prompt: string): Promise<CodexRunResult>;
}

export interface CodexEngineOpts {
  model: string;
  effort?: string;
  append: string;
  hubPort: number;
  hubToken: string;
  resumeThreadId?: string;
}

// Codex поддерживает minimal|low|medium|high|xhigh (НЕ "max", в отличие от Claude).
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };

function mcpEnv(opts: CodexEngineOpts): Record<string, string> {
  return { TG_HUB_PORT: String(opts.hubPort), TG_HUB_TOKEN: opts.hubToken };
}

function readUsage(turn: unknown): TurnUsage {
  const u = (turn as { usage?: Record<string, number> })?.usage;
  if (!u) return { ...ZERO_USAGE };
  return {
    inputTokens: u.input_tokens ?? u.inputTokens ?? 0,
    outputTokens: u.output_tokens ?? u.outputTokens ?? 0,
    cacheReadTokens: u.cached_input_tokens ?? u.cacheReadTokens ?? 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

/** Создаёт движок Codex: непрерывный thread через SDK, иначе — CLI-деградация. */
export async function createCodexEngine(opts: CodexEngineOpts): Promise<CodexEngine> {
  const codexModel = opts.model && opts.model !== "opus" ? opts.model : undefined;
  const reasoning = opts.effort && CODEX_EFFORTS.has(opts.effort) ? opts.effort : undefined;
  const intro = `${opts.append}\n\n========================================\n\n`;

  try {
    const { Codex } = await import("@openai/codex-sdk");
    const codex = new Codex({
      config: {
        mcp_servers: { telegram: { command: "bun", args: ["run", MCP_SERVER_PATH], env: mcpEnv(opts) } },
      },
    });
    const threadOpts = {
      ...(codexModel ? { model: codexModel } : {}),
      ...(reasoning ? { modelReasoningEffort: reasoning as "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
      workingDirectory: REPO_ROOT,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: true,
    };
    const thread = opts.resumeThreadId
      ? codex.resumeThread(opts.resumeThreadId, threadOpts)
      : codex.startThread(threadOpts);
    // Системные инструкции вкладываем только в ПЕРВЫЙ ход НОВОГО треда. При resume
    // контекст уже есть — не переотправляем (явный флаг надёжнее проверки thread.id).
    let introSent = Boolean(opts.resumeThreadId);
    return {
      async run(prompt: string): Promise<CodexRunResult> {
        const turn = await thread.run(introSent ? prompt : intro + prompt);
        introSent = true;
        if (turn.finalResponse) log("codex:", turn.finalResponse.slice(0, 500));
        return {
          text: turn.finalResponse ?? "",
          threadId: (thread as { id?: string }).id,
          usage: readUsage(turn),
        };
      },
    };
  } catch (e) {
    warn("Codex SDK недоступен, деградация на CLI `codex exec` (без непрерывности треда):", e instanceof Error ? e.message : e);
    return {
      async run(prompt: string): Promise<CodexRunResult> {
        const args = [
          "codex",
          "exec",
          "--cd",
          REPO_ROOT,
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-c",
          `approval_policy="never"`,
          "-c",
          `sandbox_workspace_write.network_access=true`,
          "-c",
          `mcp_servers.telegram.command="bun"`,
          "-c",
          `mcp_servers.telegram.args=["run", ${JSON.stringify(MCP_SERVER_PATH)}]`,
          ...(codexModel ? ["-m", codexModel] : []),
          intro + prompt,
        ];
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...mcpEnv(opts) } });
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) throw new Error(`codex exec завершился с кодом ${code}: ${err.slice(-500) || out.slice(-500)}`);
        log("codex(cli):", out.slice(-500));
        return { text: out, usage: { ...ZERO_USAGE } };
      },
    };
  }
}
