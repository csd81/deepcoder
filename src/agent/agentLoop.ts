import type {
  ModelProvider,
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ToolCall,
} from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult } from "../tools/types.js";
import { InvalidArgumentsError } from "../tools/types.js";
import { renderTodos } from "../tools/todoWrite.js";
import type { ApprovalMode } from "../config/config.js";
import type { DiagnosticsConfig } from "../diagnostics/types.js";
import { checkPermission } from "../permissions/policy.js";
import { compactIfNeeded } from "../context/compaction.js";
import { runPostWriteDiagnostics } from "../diagnostics/runner.js";
import { formatFile, shouldFormat } from "../tools/formatOnEdit.js";
import type { FormatConfig } from "../config/fileConfig.js";
import { isRateLimit, isAuthError, isModelError, backoffMs, abortableSleep } from "./retry.js";

export interface AgentDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  model: string;
  mode: ApprovalMode;
  maxTurns: number;
  /** Token budget + trigger fraction for history compaction. */
  contextBudgetTokens: number;
  compactAt: number;
  /** Whether execute-kind MCP tools may run (off in Phase 4A). */
  mcpExecuteEnabled?: boolean;
  /** Streaming text hook (fired per chunk when the provider supports streaming). */
  onAssistantTextDelta?(chunk: string): void;
  /** Final assistant text (fired once per turn; fallback when not streaming). */
  onAssistantText?(text: string): void;
  /**
   * Fired once after EACH assistant message completes (whether streamed or not),
   * before its tool calls execute. Lets a renderer finalize the message — e.g.
   * the TUI marks the block finished so it re-renders as markdown, and the plain
   * CLI flushes its buffered markdown.
   */
  onAssistantMessageEnd?(text: string): void;
  /** Token usage for each model call (when the provider reports it). */
  onUsage?(usage: ChatResponse["usage"]): void;
  onToolCall?(name: string, describe: string): void;
  onToolResult?(name: string, result: ToolResult): void;
  onNotice?(message: string): void;
  /** Persist session state (autosave). Called after assistant turns and tool results. */
  onPersist?(): void | Promise<void>;
  /** Approval callback for `ask` decisions. Returns true to proceed. */
  approve(invocation: ToolInvocation, preview?: ToolPreview): Promise<boolean>;
  /**
   * PreToolUse lifecycle hook (Phase 7B). Consulted AFTER the permission policy
   * allows/approves a tool but BEFORE it executes — so a hook can add a deny but
   * can never override a policy `deny` (those tools never reach here). A
   * `decision: "deny"` blocks the tool; anything else proceeds. Undefined = no hooks.
   */
  onPreToolUse?(toolName: string, invocation: ToolInvocation, ctx: ToolContext): Promise<import("../hooks/types.js").HookOutcome | undefined>;
  /**
   * Post-tool lifecycle hook (Phase 7B). Fired after a tool produces a result,
   * with `failed` reflecting `result.isError` (PostToolUse vs PostToolFailure).
   * Advisory only — it may surface warnings but can never block or undo a tool
   * that already ran. Returned warnings are reported via `onNotice`.
   */
  onPostTool?(failed: boolean, toolName: string, invocation: ToolInvocation, result: ToolResult): Promise<string[] | undefined>;
  /**
   * Phase 8A JIT instructions. Called before each model turn; returns rendered
   * path-local instruction blocks that became relevant since the last turn
   * (e.g. a nested AGENTS.md after a file under it was read). Each block is
   * returned at most once (the callback commits it), so it's injected exactly
   * once. Injected ephemerally — like todo context — without mutating history.
   */
  jitContext?(): string[];
  /**
   * Phase 7I — post-write diagnostics config. DEFAULT DISABLED. When enabled,
   * after a successful mutating tool (edit_file/write_file) the agent runs
   * matching diagnostic commands and feeds bounded output back to the model
   * via onNotice. When disabled (the default), the loop is byte-identical to
   * today — no spawn, no I/O.
   */
  diagnostics?: DiagnosticsConfig;
  /**
   * Format-on-edit config. null means not configured (no formatting).
   * After a successful mutating tool, matching files are auto-formatted.
   */
  format?: FormatConfig | null;
}

/**
 * Cumulative-tool-output threshold (bytes) that triggers the one-shot
 * read-budget focus nudge. ~100k tokens (bytes/4) — large enough not to bother
 * a focused session, small enough to catch whole-repo reads well before the
 * (e.g. 1M-token) context window fills.
 */
export const READ_BUDGET_NUDGE_BYTES = 400_000;

/**
 * Sum the byte length of all tool-role message content. Pure and testable.
 * Ignores user/assistant/system messages — only tool results count toward the
 * read budget.
 */
export function cumulativeToolBytes(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) if (m.role === "tool") total += m.content.length;
  return total;
}

/**
 * The core loop. `messages` is the running conversation (mutated in place so a
 * REPL can keep history across turns). Returns the final assistant text.
 */
export async function runAgentLoop(messages: AgentMessage[], deps: AgentDeps): Promise<string> {
  const { ctx, mode, maxTurns } = deps;
  let lastInvalidSignature: string | null = null;
  // The read-budget focus nudge is a one-shot: it fires at most once per run.
  let nudged = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (ctx.signal.aborted) {
      deps.onNotice?.("Aborted.");
      return "";
    }

    const compaction = compactIfNeeded(messages, {
      budgetTokens: deps.contextBudgetTokens,
      compactAt: deps.compactAt,
      todos: ctx.todos,
      readTracker: ctx.readTracker,
      writeTracker: ctx.writeTracker ?? new Set(),
    });
    if (compaction.compacted) {
      deps.onNotice?.(`Compacted context (~${compaction.before} → ~${compaction.after} tokens).`);
      await deps.onPersist?.();
    }

    const response = await getResponseWithRetry(deps, withEphemeralContext(messages, ctx, deps));
    deps.onUsage?.(response.usage);

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });
    if (response.text && !deps.onAssistantTextDelta) deps.onAssistantText?.(response.text);
    if (response.text) deps.onAssistantMessageEnd?.(response.text);
    await deps.onPersist?.();

    // No tool calls => the model is done.
    if (response.toolCalls.length === 0) return response.text;

    for (const call of response.toolCalls) {
      // Abort between tool calls in the same assistant turn — otherwise a Ctrl-C
      // during one tool would still let the remaining calls run.
      if (ctx.signal.aborted) {
        deps.onNotice?.("Aborted.");
        return "";
      }
      const tool = deps.registry.get(call.name);
      if (!tool) {
        pushToolResult(messages, call.id, call.name, `Unknown tool "${call.name}".`);
        await deps.onPersist?.();
        continue;
      }

      let invocation: ToolInvocation;
      try {
        invocation = tool.build(call.arguments);
        lastInvalidSignature = null;
      } catch (err) {
        if (err instanceof InvalidArgumentsError) {
          const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
          if (signature === lastInvalidSignature) {
            deps.onNotice?.(`Stopping: ${call.name} called with invalid arguments repeatedly.`);
            return "";
          }
          lastInvalidSignature = signature;
          pushToolResult(messages, call.id, call.name, err.message);
          await deps.onPersist?.();
          continue;
        }
        throw err;
      }

      const decision = checkPermission(invocation, mode, { mcpExecuteEnabled: deps.mcpExecuteEnabled });
      if (decision === "deny") {
        deps.onToolCall?.(call.name, invocation.describe());
        pushToolResult(
          messages,
          call.id,
          call.name,
          `Denied by permission policy (mode: ${mode}). This action was not run.`,
        );
        await deps.onPersist?.();
        continue;
      }

      if (decision === "ask") {
        let preview: ToolPreview | undefined;
        try {
          preview = invocation.preview ? await invocation.preview(ctx) : undefined;
        } catch {
          preview = undefined; // a preview failure must not abort the run
        }
        const approved = await deps.approve(invocation, preview);
        if (!approved) {
          pushToolResult(messages, call.id, call.name, "User rejected this action. It was not run.");
          await deps.onPersist?.();
          continue;
        }
      }

      // PreToolUse hooks fire only after the policy allowed/approved the tool, so
      // a hook deny is additive (it can never resurrect a policy-denied tool).
      if (deps.onPreToolUse) {
        const outcome = await deps.onPreToolUse(call.name, invocation, ctx);
        if (outcome?.decision === "deny") {
          deps.onToolCall?.(call.name, invocation.describe());
          pushToolResult(
            messages,
            call.id,
            call.name,
            `Blocked by hook: ${outcome.reason ?? "denied"}. This action was not run.`,
          );
          await deps.onPersist?.();
          continue;
        }
      }

      deps.onToolCall?.(call.name, invocation.describe());
      // A tool that throws (e.g. read_file on a missing path) must not abort the
      // whole run — turn it into a recoverable tool-result the model can react to.
      let result: ToolResult;
      try {
        result = await invocation.execute(ctx);
      } catch (err) {
        // An abort must stop the whole run, not be swallowed as a recoverable error.
        if (ctx.signal.aborted || (err as Error).name === "AbortError") {
          deps.onNotice?.("Aborted.");
          return "";
        }
        result = { output: `Tool ${call.name} failed: ${(err as Error).message ?? String(err)}`, isError: true };
      }
      deps.onToolResult?.(call.name, result);
      pushToolResult(messages, call.id, call.name, result.output);
      await deps.onPersist?.();

      // One-shot read-budget focus nudge. A soft nudge only — nothing is
      // blocked, truncated, or removed. Fires at most once per run, when the
      // cumulative tool-output bytes first cross the threshold (a model hoarding
      // whole-file reads instead of converging on a hypothesis).
      if (!nudged) {
        const bytes = cumulativeToolBytes(messages);
        if (bytes >= READ_BUDGET_NUDGE_BYTES) {
          nudged = true;
          const approxTokens = Math.round(bytes / 4 / 1000);
          messages.push({
            role: "system",
            content:
              `You have read a large amount of file content (~${approxTokens}k tokens) without converging. ` +
              `Narrow your hypothesis: use grep/repo_map and read only the specific lines you need ` +
              `(read_file offset/limit) instead of whole files. Do not re-read files already in context.`,
          });
          deps.onNotice?.(`Read-budget nudge: ~${approxTokens}k tokens of file content read — asked the model to narrow its focus.`);
          await deps.onPersist?.();
        }
      }

      // Post-tool hooks are advisory: they observe the result but can't undo it.
      if (deps.onPostTool) {
        try {
          const warnings = await deps.onPostTool(!!result.isError, call.name, invocation, result);
          for (const w of warnings ?? []) deps.onNotice?.(`hook: ${w}`);
        } catch {
          // an advisory post-hook must never break the loop
        }
      }

      // Phase 7I — post-write diagnostics. Only on SUCCESSFUL mutate tools.
      // When diagnostics are disabled (the default), this is a no-op.
      if (!result.isError && invocation.kind === "mutate" && invocation.affectedPaths && deps.diagnostics) {
        try {
          const diagRuns = await runPostWriteDiagnostics({
            workspaceRoot: ctx.workspaceRoot,
            affectedPaths: invocation.affectedPaths,
            config: deps.diagnostics,
            sandbox: ctx.sandbox,
            signal: ctx.signal,
          });
          for (const dr of diagRuns) {
            deps.onNotice?.(renderDiagnosticNotice(dr));
          }
        } catch {
          // A diagnostic failure must never break the agent loop.
        }
      }

      // Format-on-edit. Only on SUCCESSFUL mutate tools, only when configured.
      if (!result.isError && invocation.kind === "mutate" && invocation.affectedPaths?.length && deps.format) {
        try {
          for (const file of invocation.affectedPaths) {
            if (!shouldFormat(file, deps.format)) continue;
            const outcome = await formatFile(file, deps.format, {
              workspaceRoot: ctx.workspaceRoot,
              sandbox: ctx.sandbox,
              signal: ctx.signal,
            });
            if (outcome.formatted) {
              deps.onNotice?.(`formatted ${file}`);
            } else if (outcome.error) {
              deps.onNotice?.(`format ${file}: ${outcome.error}`);
            }
          }
        } catch {
          // A format failure must never break the agent loop.
        }
      }
    }
  }

  deps.onNotice?.(`Reached max turns (${maxTurns}).`);
  return "";
}

/**
 * Append ephemeral context (todo list + newly-relevant JIT path-local
 * instructions) for the upcoming model call, without mutating persisted
 * history. JIT blocks are pulled once via `deps.jitContext()`.
 */
function withEphemeralContext(messages: AgentMessage[], ctx: ToolContext, deps: AgentDeps): AgentMessage[] {
  const extra: AgentMessage[] = [];
  if (ctx.todos.length > 0) {
    extra.push({ role: "system", content: `Current todo list:\n${renderTodos(ctx.todos)}` });
  }
  for (const block of deps.jitContext?.() ?? []) {
    extra.push({ role: "system", content: block });
  }
  return extra.length ? [...messages, ...extra] : messages;
}

/**
 * Produce a provider-safe copy of the message list: every assistant tool-call
 * must have its tool result present, and every tool message must have its
 * owning assistant call. OpenAI-compatible APIs reject either kind of dangling
 * reference. This defends against compaction boundaries AND corrupted/resumed
 * history. Operates on a copy — stored history is never mutated.
 */
export function sanitizeForProvider(messages: AgentMessage[]): AgentMessage[] {
  const presentResultIds = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) presentResultIds.add(m.toolCallId);

  const keptCallIds = new Set<string>();
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const calls = m.toolCalls.filter((c) => presentResultIds.has(c.id));
      for (const c of calls) keptCallIds.add(c.id);
      if (calls.length === 0 && !m.content) continue; // empty, useless turn
      out.push(calls.length ? { ...m, toolCalls: calls } : { ...m, toolCalls: undefined });
    } else if (m.role === "tool") {
      if (m.toolCallId && keptCallIds.has(m.toolCallId)) out.push(m);
      // else: orphan tool result — drop it
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Thrown by {@link consumeStream} when a model stream fails (an explicit
 * `error` event or a mid-iteration connection drop). `hadContent` is true if
 * any assistant text or tool call was already received before the failure.
 *
 * The distinction drives recovery: a failure AFTER content has streamed must
 * abort the turn (the partial output is already on the user's screen — a
 * non-streaming retry would duplicate it AND could mask the failure as a
 * silent success), whereas an early, no-content failure can safely fall back
 * to a non-streaming `chat()` call.
 */
export class StreamError extends Error {
  readonly hadContent: boolean;
  constructor(message: string, hadContent: boolean) {
    super(message);
    this.name = "StreamError";
    this.hadContent = hadContent;
  }
}

/**
 * Call the provider with graceful error recovery. Rate-limit (429) and other
 * transient errors retry with exponential backoff (signal-aware sleep);
 * auth (401) and bad-model (404/400) errors are fatal and re-thrown
 * immediately with a clear notice. A stream error that already streamed
 * content is never retried. On retry exhaustion the original error is
 * RE-THROWN (never a fake-success empty response) so the caller reports it.
 *
 * `opts.sleep` is injectable so tests can avoid real timers.
 */
export async function getResponseWithRetry(
  deps: AgentDeps,
  sent: AgentMessage[],
  opts?: { maxRetries?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Promise<ChatResponse> {
  const maxRetries = opts?.maxRetries ?? 2;
  const sleep = opts?.sleep ?? abortableSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getResponse(deps, sent);
    } catch (err) {
      lastError = err;
      // A propagated stream error (content already streamed) is fatal — never
      // retry it, or a real mid-turn failure would be masked as success.
      if (err instanceof StreamError) throw err;
      if (deps.ctx.signal.aborted) throw err;
      if (isAuthError(err)) {
        deps.onNotice?.("API key rejected — check your credentials.");
        throw err;
      }
      if (isModelError(err)) {
        deps.onNotice?.(`Model "${deps.model}" unavailable — check the model name.`);
        throw err;
      }
      if (attempt < maxRetries) {
        const wait = backoffMs(attempt);
        deps.onNotice?.(
          isRateLimit(err)
            ? `Rate limited — retrying in ${wait}ms… (${attempt + 1}/${maxRetries})`
            : `API error — retrying… (${attempt + 1}/${maxRetries})`,
        );
        await sleep(wait, deps.ctx.signal);
        if (deps.ctx.signal.aborted) throw err;
        continue;
      }
    }
  }
  deps.onNotice?.(
    `Provider unreachable after ${maxRetries + 1} attempts: ${(lastError as Error)?.message ?? String(lastError)}.`,
  );
  throw lastError;
}

/** Use streaming when the provider supports it; otherwise a single chat() call. */
export async function getResponse(deps: AgentDeps, sent: AgentMessage[]): Promise<ChatResponse> {
  const req: ChatRequest = {
    messages: sanitizeForProvider(sent),
    tools: deps.registry.schemas(),
    model: deps.model,
    signal: deps.ctx.signal,
  };
  if (deps.provider.streamChat) {
    try {
      return await consumeStream(deps.provider.streamChat(req), deps.onAssistantTextDelta);
    } catch (err) {
      if (deps.ctx.signal.aborted || (err as Error)?.name === "AbortError") throw err;
      // Content already on screen → propagate (no duplicate re-run, no masking).
      if (err instanceof StreamError && err.hadContent) throw err;
      // Early, no-content stream failure → safe to retry on the non-streaming path.
      deps.onNotice?.("Stream interrupted — falling back to non-streaming…");
      return deps.provider.chat(req);
    }
  }
  return deps.provider.chat(req);
}

export async function consumeStream(
  stream: AsyncIterable<ModelEvent>,
  onDelta?: (chunk: string) => void,
): Promise<ChatResponse> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: ChatResponse["usage"];
  let hadContent = false;
  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "assistant_text_delta":
          text += ev.text;
          hadContent = true;
          onDelta?.(ev.text);
          break;
        case "tool_call_complete":
          toolCalls.push(ev.toolCall);
          hadContent = true;
          break;
        case "error":
          throw new StreamError(ev.message, hadContent);
        case "done":
          usage = ev.usage;
          break;
      }
    }
  } catch (err) {
    if (err instanceof StreamError) throw err;
    // A mid-iteration connection drop — wrap with the current content state.
    throw new StreamError((err as Error)?.message ?? String(err), hadContent);
  }
  return { text, toolCalls, usage };
}

function pushToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  name: string,
  content: string,
): void {
  messages.push({ role: "tool", toolCallId, name, content });
}

/**
 * Render a DiagnosticRun into a human-readable notice for the model.
 * Bounded to ~4 KB (the summary is already capped by the runner).
 */
function renderDiagnosticNotice(dr: import("../diagnostics/types.js").DiagnosticRun): string {
  const lines: string[] = [];
  lines.push(`Post-write diagnostic "${dr.name}" — ${dr.exitCode === 0 ? "passed" : "failed"}`);
  if (dr.affectedPaths.length > 0) {
    lines.push(`Affected: ${dr.affectedPaths.join(", ")}`);
  }
  if (dr.summary) {
    lines.push(dr.summary);
  }
  return lines.join("\n");
}
