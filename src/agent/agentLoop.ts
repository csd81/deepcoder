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
import type { ApprovalMode } from "../config/config.js";
import type { DiagnosticsConfig } from "../diagnostics/types.js";
import { buildMessagesForQuery } from "../context/queryProjection.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { isSummary } from "../context/compaction.js";
import type { FormatConfig } from "../config/fileConfig.js";
import { isRateLimit, isAuthError, isModelError, isContextOverflowError, backoffMs, abortableSleep } from "./retry.js";
import { recoverContextOverflow } from "../context/overflowRecovery.js";
import { formatTokenUsageReminder, shouldEmitTokenUsageReminder } from "./tokenUsageReminder.js";
import {
  ToolCallProcessor,
  type ToolLoopState,
  envFlagOn,
  readConcurrencyFromEnv,
} from "./toolExecution.js";
import { StreamingToolExecutor } from "./streamingToolExecutor.js";
import { consumeStreamWithToolExecution } from "./streamingConsume.js";

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
  /** Run the Trident redundancy pass before summarizing (default via env). */
  tridentCompaction?: boolean;
  /** Five-stage context pipeline feature toggles (optional stages default off). */
  contextPipeline?: { budgetReduce: boolean; snip: boolean; autoCompact: boolean };
  /** Reactive context-overflow recovery (default on). Bounded one-shot retry. */
  reactiveOverflowRecovery?: boolean;
  /** Max reactive overflow recoveries per turn (default 1, capped at 2). */
  overflowRecoveryMaxAttempts?: number;
  /** Aggressive tail ratio for overflow recovery (default 0.15). */
  overflowAggressiveTailRatio?: number;
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
  /**
   * Flight-recorder seam. Called with the EXACT compiled `ChatRequest` just
   * before it is sent to the provider (post-`sanitizeForProvider`, covering both
   * the streaming and non-streaming paths). Fires once per model call —
   * including each retry attempt, so every attempt is captured. Advisory only: a
   * failure here is swallowed and surfaced via `onNotice` and NEVER aborts the
   * turn. Undefined = recording disabled (the loop is byte-identical to today).
   */
  onModelCall?(request: ChatRequest): void | Promise<void>;
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
   * Delegation assessment hint. Consulted once per turn (like jitContext) and
   * injected as ephemeral system context. Advisory only — it nudges the model
   * toward the `delegate` tool for broad/multi-area work; it never invokes
   * delegation itself. Yields its hint once, then []. Subagents are NOT given
   * this callback (prevents recursion). Undefined = no nudge.
   */
  delegationHint?(): string[];
  /**
   * ACE-style playbook injection (opt-in). Consulted once per turn (like
   * jitContext) and injected as an ephemeral, ADVISORY system block of
   * accumulated helpful strategies. Never authoritative — it cannot change
   * permissions or policy. Undefined = playbook disabled.
   */
  playbookContext?(): string[];
  /** Bounded `[deferred-tools]` catalog block(s) for deferred tool schemas. */
  deferredToolsCatalog?(): string[];
  /** Advisory `[project-guidance]` block(s) when guidance-vs-enforcement is on. */
  guidanceContext?(): string[];
  /**
   * Advisory `[relevant-memory]` block(s) prefetched per turn from accepted
   * memory files (async — reads disk). Injected ephemerally into this call only.
   */
  relevantMemory?(prompt: string, recent: AgentMessage[]): Promise<string[]>;
  /**
   * Cache-Optimized Context: reconcile dynamic context sources (approval mode,
   * instructions, memory) against the session's epoch snapshot. Called at the
   * top of every turn; returns zero or one persisted `[context-update]` system
   * message(s) to append when a source changed — NEVER rewrites messages[0], so
   * the prefix cache survives. The closure updates the session snapshot.
   */
  reconcileContext?(): AgentMessage[];
  /**
   * Cache-Optimized Context: start a fresh context epoch after compaction —
   * rebuild messages[0] from current sources, strip stale `[context-update]`
   * messages, and reset the session snapshot. Invoked only when a compaction
   * actually fired.
   */
  onContextEpochReset?(): void | Promise<void>;
  /**
   * Compaction lifecycle hooks (advisory; cannot block). `onPreCompact` fires
   * before the pipeline reduces history; `onPostCompact` after, and its returned
   * `context` lines are injected as a bounded one-shot guidance note into THIS
   * call only. Both surface `warnings` via `onNotice`; failures never break the
   * loop.
   */
  onPreCompact?(input: import("../hooks/types.js").PreCompactInput): Promise<import("../hooks/types.js").AdvisoryOutcome | undefined>;
  onPostCompact?(input: import("../hooks/types.js").PostCompactInput): Promise<import("../hooks/types.js").AdvisoryOutcome | undefined>;
  /**
   * Model-escalation hook. Called when the SAME tool produces the SAME error
   * twice in a row. Returns a stronger model id to switch to for the rest of
   * the run (sticky), or undefined to stay put (e.g. already escalated, or a
   * manual `/model` override is in force). Undefined hook = no escalation.
   */
  onRepeatedToolError?(): string | undefined;
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
  /**
   * Copy-on-write hook. Invoked for EACH tool call after the permission policy
   * allows/approves it and PreToolUse hooks pass, but BEFORE execute(). When the
   * invocation is a write-effect and no worktree is active yet, the implementation
   * provisions a disposable worktree and MUTATES ctx.workspaceRoot in place so
   * this and every later tool in the turn writes into the worktree. No-op for
   * read-only tools and when already isolated. Throwing aborts only this tool
   * (turned into a recoverable tool-result), e.g. when the real tree is dirty.
   * Undefined = disabled (writes go straight to the real root).
   */
  ensureWritableRoot?(invocation: ToolInvocation): Promise<void>;
}

/**
 * Cumulative-tool-output threshold (bytes) that triggers the one-shot
 * read-budget focus nudge. ~100k tokens (bytes/4) — large enough not to bother
 * a focused session, small enough to catch whole-repo reads well before the
 * (e.g. 1M-token) context window fills.
 */
export const READ_BUDGET_NUDGE_BYTES = 400_000;

/**
 * Per-message cap (bytes) on a single stored tool result. A single huge tool
 * result (e.g. a whole-file read of a giant file) would otherwise be stored
 * whole and land in the kept tail, blowing the context budget on its own.
 * Generous enough not to clip normal results; results above it are truncated
 * with an explicit marker so the model knows content was cut.
 */
export const MAX_TOOL_RESULT_BYTES = 100_000;

/**
 * Cap an individual tool-result string before it is stored in history. Returns
 * the input unchanged when within the bound; otherwise keeps a leading slice
 * and appends a clear truncation marker noting how many bytes were dropped.
 */
export function capToolResult(content: string, max = MAX_TOOL_RESULT_BYTES): string {
  if (content.length <= max) return content;
  const dropped = content.length - max;
  return (
    content.slice(0, max) +
    `\n\n[... tool result truncated: ${dropped} of ${content.length} bytes omitted to fit the context budget ...]`
  );
}

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
  // One-shot token-usage system reminder (mirrors the read-budget nudge).
  let tokenReminded = false;
  // Run-scoped tool-execution bookkeeping, shared by the serial and streaming
  // paths via ToolCallProcessor. Mutated in place across turns:
  //  - lastInvalidSignature: stop on a repeated identical invalid-args call.
  //  - lastToolErrorSig: detect the SAME tool error twice in a row.
  //  - curModel: model id this run (may be bumped by escalation; sticky).
  //  - nudged: one-shot read-budget focus nudge.
  //  - readBytes: cumulative UNCAPPED tool-output bytes read this run (the nudge
  //    keys on read *volume*, not on what we stored after capToolResult).
  const state: ToolLoopState = {
    lastInvalidSignature: null,
    lastToolErrorSig: null,
    curModel: deps.model,
    nudged: false,
    readBytes: 0,
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (ctx.signal.aborted) {
      deps.onNotice?.("Aborted.");
      return "";
    }

    // Build the per-call provider projection: canonical `messages` →
    // `messagesForQuery`. This is the single pre-model chokepoint — it runs the
    // durable stages (deterministic compaction, then cache-optimized context
    // reconciliation, both mutating `messages` in place) and layers ephemeral
    // context onto a fresh array. The async durable side-effects below stay here,
    // driven by the returned flags, so persistence ordering is unchanged.
    // Compaction lifecycle: PreCompact fires (advisory) when the pipeline is about
    // to reduce history (over the trigger). It can warn but never block.
    const beforeTokens = estimateMessages(messages);
    const triggerTokens = Math.floor(deps.contextBudgetTokens * deps.compactAt);
    const willReduce = beforeTokens > triggerTokens;
    if (willReduce && deps.onPreCompact) {
      try {
        const out = await deps.onPreCompact({ beforeTokens, triggerTokens, force: false, stage: "auto" });
        out?.warnings.forEach((w) => deps.onNotice?.(`PreCompact hook: ${w}`));
      } catch (err) {
        deps.onNotice?.(`hook PreCompact error: ${(err as Error)?.message ?? String(err)}`);
      }
    }

    const projection = buildMessagesForQuery({ messages, ctx, deps });
    const compaction = projection.compaction;
    if (compaction.compacted) {
      deps.onNotice?.(`Compacted context (~${compaction.before} → ~${compaction.after} tokens).`);
      // Start a fresh context epoch: rebuild messages[0] from current sources and
      // drop stale [context-update]s now folded into the new baseline.
      await deps.onContextEpochReset?.();
      await deps.onPersist?.();
    }
    // Cache-Optimized Context: reconciliation appended a single [context-update]
    // at the tail (a dynamic source like /mode changed), leaving messages[0] —
    // and thus the whole cached prefix — untouched. Persist that durable append.
    if (projection.contextUpdatesAppended) {
      await deps.onPersist?.();
    }

    // PostCompact fires after the reduction with real stats; its advisory context
    // is injected as a one-shot guidance note into THIS call only (never persisted).
    if (willReduce && deps.onPostCompact) {
      try {
        const out = await deps.onPostCompact({
          beforeTokens,
          afterTokens: estimateMessages(messages),
          stages: projection.stageStats,
          summaryPreview: messages.find(isSummary)?.content?.slice(0, 200),
        });
        out?.warnings.forEach((w) => deps.onNotice?.(`PostCompact hook: ${w}`));
        if (out?.context.length) {
          // Reassign (not push): messagesForQuery may alias canonical `messages`
          // when there is no ephemeral context — a push would persist the note.
          projection.messagesForQuery = [
            ...projection.messagesForQuery,
            { role: "system", content: out.context.join("\n") },
          ];
        }
      } catch (err) {
        deps.onNotice?.(`hook PostCompact error: ${(err as Error)?.message ?? String(err)}`);
      }
    }

    // Track whether ANY streaming delta actually fired for this turn's response.
    // The final-text fallback must key on real emission, not merely on whether
    // the delta callback is wired — a non-streaming path (stream fallback or a
    // provider without streamChat) emits no deltas even when the callback exists,
    // and that final text must still reach the renderer.
    let streamedDelta = false;
    // turnDeps carries the current (possibly escalated) model. When no
    // escalation has occurred, curModel === deps.model so this is byte-identical
    // to using deps directly.
    const turnDeps: AgentDeps = {
      ...deps,
      model: state.curModel,
      ...(deps.onAssistantTextDelta
        ? {
            onAssistantTextDelta: (chunk: string) => {
              streamedDelta = true;
              deps.onAssistantTextDelta!(chunk);
            },
          }
        : {}),
    };

    // Relevant-memory prefetch: inject advisory `[relevant-memory]` blocks for
    // this call only (ephemeral — reassign, never mutate canonical history).
    if (deps.relevantMemory) {
      try {
        const prompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const blocks = await deps.relevantMemory(prompt, messages);
        if (blocks.length) {
          projection.messagesForQuery = [
            ...projection.messagesForQuery,
            ...blocks.map((content) => ({ role: "system" as const, content })),
          ];
        }
      } catch (err) {
        deps.onNotice?.(`memory prefetch error: ${(err as Error)?.message ?? String(err)}`);
      }
    }

    // ── Streaming tool execution (env-gated; default OFF) ────────────────────
    // When DEEPCODER_STREAMING_TOOLS is on AND the provider can stream, execute
    // complete streamed tool calls as they arrive: read-lane (read-only/session)
    // tools run concurrently up to a small cap, mutate/execute tools serialize,
    // and every real execution still routes through the SAME ToolCallProcessor
    // helpers (permission gate, hooks, copy-on-write, persistence). Results are
    // appended to history strictly in call-index order. The serial path below is
    // unchanged when the flag is off.
    if (envFlagOn(process.env.DEEPCODER_STREAMING_TOOLS) && deps.provider.streamChat) {
      const outcome = await runStreamingToolTurn({
        deps,
        turnDeps,
        ctx,
        mode,
        messages,
        state,
        sent: projection.messagesForQuery,
        streamedDelta: () => streamedDelta,
        tokenReminded,
        setTokenReminded: () => {
          tokenReminded = true;
        },
      });
      if (outcome.kind === "return") return outcome.text;
      // outcome.kind === "next" → proceed to the next turn.
      continue;
    }

    // Reactive context-overflow recovery: if the provider rejects the request as
    // too long, force an aggressive compaction and retry the SAME call once
    // (bounded). No tools run during recovery; an unrecovered overflow stops the
    // turn with a clear notice rather than a fake success.
    const maxOverflow = Math.min(2, Math.max(0, deps.overflowRecoveryMaxAttempts ?? 1));
    const overflowOn = deps.reactiveOverflowRecovery !== false;
    let sentForQuery = projection.messagesForQuery;
    let overflowAttempts = 0;
    let response: ChatResponse;
    for (;;) {
      try {
        response = await getResponseWithRetry(turnDeps, sentForQuery);
        break;
      } catch (err) {
        if (!isContextOverflowError(err) || !overflowOn || overflowAttempts >= maxOverflow) {
          if (isContextOverflowError(err) && overflowAttempts > 0) {
            deps.onNotice?.(
              "Context overflow after recovery. I compacted the conversation but the provider still rejected the prompt as too large. Start a new session or narrow the task.",
            );
          }
          throw err;
        }
        overflowAttempts++;
        deps.onNotice?.("Provider rejected context as too large; compacting aggressively and retrying once.");
        const rec = recoverContextOverflow(messages, {
          budgetTokens: deps.contextBudgetTokens,
          compactAt: deps.compactAt,
          todos: ctx.todos,
          readTracker: ctx.readTracker,
          writeTracker: ctx.writeTracker ?? new Set(),
          aggressiveTailRatio: deps.overflowAggressiveTailRatio,
        });
        if (!rec.recovered) {
          deps.onNotice?.("Context overflow persisted after recovery.");
          throw err;
        }
        // Durable recovery mutated history: reset the epoch, persist, rebuild the
        // projection (avoids duplicate [context-update]s), then retry.
        await deps.onContextEpochReset?.();
        await deps.onPersist?.();
        sentForQuery = buildMessagesForQuery({ messages, ctx, deps }).messagesForQuery;
        deps.onNotice?.(`Recovered from context overflow (~${rec.before} → ~${rec.after} tokens).`);
      }
    }
    deps.onUsage?.(response.usage);

    // One-shot token-usage system reminder: fire when the provider-reported
    // promptTokens first crosses compactAt × contextBudgetTokens.
    if (!tokenReminded && response.usage?.promptTokens !== undefined) {
      if (shouldEmitTokenUsageReminder(response.usage.promptTokens, deps.contextBudgetTokens, deps.compactAt)) {
        tokenReminded = true;
        messages.push({
          role: "system",
          content: formatTokenUsageReminder(response.usage.promptTokens, deps.contextBudgetTokens),
        });
        deps.onNotice?.(
          `Token-usage reminder: ${response.usage.promptTokens} of ${deps.contextBudgetTokens} tokens used.`,
        );
        await deps.onPersist?.();
      }
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });
    if (response.text && !streamedDelta) deps.onAssistantText?.(response.text);
    deps.onAssistantMessageEnd?.(response.text);
    await deps.onPersist?.();

    // No tool calls => the model is done.
    if (response.toolCalls.length === 0) return response.text;

    // Serial tool execution (the default). Each call passes through the SAME
    // ToolCallProcessor helpers the streaming path uses, in the original order:
    // authorize (build + gate) → execute (copy-on-write + run) → record. With the
    // streaming flag off this is byte-equivalent to the original inline body.
    const proc = new ToolCallProcessor({ deps, ctx, mode, messages, state });
    for (const call of response.toolCalls) {
      // Abort between tool calls in the same assistant turn — otherwise a Ctrl-C
      // during one tool would still let the remaining calls run.
      if (ctx.signal.aborted) {
        deps.onNotice?.("Aborted.");
        return "";
      }
      const auth = await proc.authorize(call);
      if (auth.kind === "stop") return ""; // repeated invalid args (notice already emitted)
      if (auth.kind === "blocked") {
        await proc.recordBlocked(call, auth.render, auth.result);
        continue;
      }
      const exec = await proc.execute(call, auth.invocation);
      if (exec.kind === "abort") {
        deps.onNotice?.("Aborted.");
        return "";
      }
      if (exec.kind === "blocked") {
        // Copy-on-write provisioning failed → recoverable synthetic result.
        await proc.recordBlocked(call, "synthetic", exec.result);
        continue;
      }
      await proc.recordRanResult(call, auth.invocation, exec.result);
    }
  }

  deps.onNotice?.(`Reached max turns (${maxTurns}).`);
  return "";
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
      // Context overflow is NOT a transient failure — throw it immediately so the
      // loop can run a one-shot reactive recovery (it must beat isModelError's
      // 400 match, which would otherwise treat it as a fatal model error).
      if (isContextOverflowError(err)) throw err;
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
  // Flight recorder: snapshot the exact compiled payload before it leaves the
  // machine. Advisory — a recorder failure must never abort the turn.
  if (deps.onModelCall) {
    try {
      await deps.onModelCall(req);
    } catch (err) {
      deps.onNotice?.(`flight recorder error: ${(err as Error)?.message ?? String(err)}`);
    }
  }
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

interface StreamingTurnParams {
  deps: AgentDeps;
  /** Per-turn deps carrying the (possibly escalated) model + delta wrapper. */
  turnDeps: AgentDeps;
  ctx: ToolContext;
  mode: ApprovalMode;
  messages: AgentMessage[];
  state: ToolLoopState;
  /** The final per-call provider projection to send. */
  sent: AgentMessage[];
  /** Whether a streaming delta actually fired this turn (read fresh). */
  streamedDelta: () => boolean;
  /** Current value of the one-shot token-usage reminder flag. */
  tokenReminded: boolean;
  /** Flip the outer one-shot token-usage reminder flag. */
  setTokenReminded: () => void;
}

/**
 * Run ONE assistant turn on the streaming tool-execution path: stream the model
 * response, executing complete tool calls as they arrive via a
 * `StreamingToolExecutor`, then append results to history in call-index order.
 *
 * Mirrors the serial turn's model-call scaffolding (flight recorder, usage,
 * token-usage reminder, assistant-message append, no-tool-calls finish) but
 * interleaves tool execution with the stream. Returns `{kind:"return"}` to end
 * the run (done / abort / repeated-invalid-args) or `{kind:"next"}` to continue.
 *
 * NOTE: this experimental path does NOT wrap the model call in the serial path's
 * retry/backoff + reactive-overflow recovery (those wrap a fully-buffered
 * response, which is incompatible with executing tools mid-stream). It keeps the
 * same no-content fallback to `chat()` and the same post-content propagate-and-
 * abort policy as `getResponse`.
 */
async function runStreamingToolTurn(
  p: StreamingTurnParams,
): Promise<{ kind: "return"; text: string } | { kind: "next" }> {
  const { deps, turnDeps, ctx, mode, messages, state, sent } = p;
  if (ctx.signal.aborted) {
    deps.onNotice?.("Aborted.");
    return { kind: "return", text: "" };
  }

  const req: ChatRequest = {
    messages: sanitizeForProvider(sent),
    tools: deps.registry.schemas(),
    model: turnDeps.model,
    signal: ctx.signal,
  };
  // Flight recorder — advisory; a recorder failure must never abort the turn.
  if (deps.onModelCall) {
    try {
      await deps.onModelCall(req);
    } catch (err) {
      deps.onNotice?.(`flight recorder error: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  const proc = new ToolCallProcessor({ deps, ctx, mode, messages, state });
  // Child abort so a post-content stream failure can stop in-flight tool work
  // (the executor links its own child to this signal too). Also aborts on user abort.
  const streamAbort = new AbortController();
  if (ctx.signal.aborted) streamAbort.abort();
  else ctx.signal.addEventListener("abort", () => streamAbort.abort(), { once: true });

  const makeExecutor = (): StreamingToolExecutor =>
    new StreamingToolExecutor({
      classify: (call) => proc.classifyForExecutor(call),
      authorize: (call) => proc.authorizeForExecutor(call),
      execute: (call, signal) => proc.executeForExecutor(call, signal),
      readConcurrency: readConcurrencyFromEnv(),
      signal: streamAbort.signal,
    });

  let executor = makeExecutor();
  let assembled: { text: string; toolCalls: ToolCall[]; usage?: ChatResponse["usage"] };
  try {
    assembled = await consumeStreamWithToolExecution(
      deps.provider.streamChat!(req),
      executor,
      turnDeps.onAssistantTextDelta,
    );
  } catch (err) {
    if (ctx.signal.aborted || (err as Error)?.name === "AbortError") {
      deps.onNotice?.("Aborted.");
      return { kind: "return", text: "" };
    }
    const hadContent = (err as { hadContent?: boolean })?.hadContent === true;
    if (hadContent) {
      // Content already streamed → stop in-flight tools and propagate (no
      // duplicate re-run, no masking), mirroring getResponse's StreamError path.
      streamAbort.abort();
      throw new StreamError((err as Error)?.message ?? String(err), true);
    }
    // Early, no-content stream failure → fall back to a non-streaming chat() and
    // run its tool calls through a FRESH executor (the failed one already
    // finished and would ignore further accept() calls).
    deps.onNotice?.("Stream interrupted — falling back to non-streaming…");
    const resp = await deps.provider.chat(req);
    executor = makeExecutor();
    for (const c of resp.toolCalls) executor.accept(c);
    executor.finishAssistant();
    assembled = { text: resp.text, toolCalls: resp.toolCalls, usage: resp.usage };
  }

  deps.onUsage?.(assembled.usage);

  // One-shot token-usage system reminder (same trigger as the serial path).
  if (!p.tokenReminded && assembled.usage?.promptTokens !== undefined) {
    if (shouldEmitTokenUsageReminder(assembled.usage.promptTokens, deps.contextBudgetTokens, deps.compactAt)) {
      p.setTokenReminded();
      messages.push({
        role: "system",
        content: formatTokenUsageReminder(assembled.usage.promptTokens, deps.contextBudgetTokens),
      });
      deps.onNotice?.(
        `Token-usage reminder: ${assembled.usage.promptTokens} of ${deps.contextBudgetTokens} tokens used.`,
      );
      await deps.onPersist?.();
    }
  }

  messages.push({
    role: "assistant",
    content: assembled.text,
    toolCalls: assembled.toolCalls.length ? assembled.toolCalls : undefined,
  });
  if (assembled.text && !p.streamedDelta()) deps.onAssistantText?.(assembled.text);
  deps.onAssistantMessageEnd?.(assembled.text);
  await deps.onPersist?.();

  // No tool calls => the model is done.
  if (assembled.toolCalls.length === 0) return { kind: "return", text: assembled.text };

  // Drain executor results in call-index order and record each into history, so
  // history append order matches the assistant's tool-call order (keeps
  // sanitizeForProvider valid even when reads finished out of order).
  for await (const update of executor.updates()) {
    if (ctx.signal.aborted) break;
    await proc.recordUpdate(update.call, update.result!);
  }

  if (ctx.signal.aborted) {
    deps.onNotice?.("Aborted.");
    return { kind: "return", text: "" };
  }
  if (proc.stopRequested) return { kind: "return", text: "" };
  return { kind: "next" };
}
