/**
 * toolExecution — the shared per-tool-call execution body extracted out of
 * `runAgentLoop`.
 *
 * The serial path (default) and the env-gated streaming path
 * (`DEEPCODER_STREAMING_TOOLS`) both route every real tool execution through the
 * SAME helpers here, so the permission gate, ask-approval, PreToolUse hook,
 * copy-on-write provisioning, execution, result offload/persistence, and the
 * model-escalation / read-budget bookkeeping are written exactly once.
 *
 * Phases:
 *   1. `authorize(call)`  — build + classify + permission + ask + PreToolUse.
 *                           Returns an invocation to run, a synthetic blocked
 *                           result, or a full-run stop.
 *   2. `execute(call, invocation)` — copy-on-write provisioning + the real
 *                           `invocation.execute(ctx)`.
 *   3. `recordRanResult(...)` / `recordBlocked(...)` — push the result into
 *                           history (in order) and run the post-result hooks.
 *
 * The streaming path additionally wires `classifyForExecutor` / `authorizeForExecutor`
 * / `executeForExecutor` into a `StreamingToolExecutor`, which runs read-lane
 * calls concurrently and serializes exclusive calls while preserving call-index
 * result order. `executeForExecutor` enforces drain-before-exclusive: an
 * exclusive (mutate/execute) call waits for all earlier in-flight reads to settle
 * before its copy-on-write provisioning or execution runs, so a write can never
 * race an earlier read on the working tree.
 *
 * Byte-equivalence: with the flag off, the serial path calls these helpers in the
 * exact original order with the original side effects; nothing here changes
 * observable behavior.
 */

import type { AgentDeps } from "./agentLoop.js";
import { capToolResult, MAX_TOOL_RESULT_BYTES, READ_BUDGET_NUDGE_BYTES } from "./agentLoop.js";
import type { AgentMessage, ToolCall } from "../providers/types.js";
import type { ApprovalMode } from "../config/config.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult } from "../tools/types.js";
import { InvalidArgumentsError } from "../tools/types.js";
import { checkPermission } from "../permissions/policy.js";
import { runPostWriteDiagnostics } from "../diagnostics/runner.js";
import { formatFile, shouldFormat } from "../tools/formatOnEdit.js";
import { saveManagedOutput } from "../session/managedOutputs.js";
import type { ExecutionLane } from "./streamingToolExecutor.js";

/**
 * Run-scoped mutable bookkeeping shared across every tool call in a run. Lives in
 * `runAgentLoop` (so it persists across turns) and is mutated in place by the
 * helpers — exactly the `let` variables the serial body used to close over.
 */
export interface ToolLoopState {
  /** Signature of the last invalid-args call, to stop on a repeated identical one. */
  lastInvalidSignature: string | null;
  /** Signature of the last tool error, to detect the SAME error twice in a row. */
  lastToolErrorSig: string | null;
  /** The model id used this run (may be bumped by escalation; sticky). */
  curModel: string;
  /** One-shot read-budget focus nudge fired? */
  nudged: boolean;
  /** Cumulative UNCAPPED tool-output bytes read this run. */
  readBytes: number;
}

/** How a blocked (non-executing) call renders: synthetic result vs. a policy/hook deny. */
export type BlockRender = "synthetic" | { denied: string };

/** Outcome of {@link ToolCallProcessor.authorize}. */
export type Authorization =
  | { kind: "execute"; invocation: ToolInvocation }
  | { kind: "blocked"; render: BlockRender; result: ToolResult }
  /** Full-run stop (repeated invalid args). The notice is already emitted. */
  | { kind: "stop" };

/** Outcome of {@link ToolCallProcessor.execute}. */
export type Execution =
  | { kind: "ran"; result: ToolResult }
  /** Copy-on-write provisioning failed → recoverable synthetic result. */
  | { kind: "blocked"; result: ToolResult }
  /** User abort during execution → stop the whole run. */
  | { kind: "abort" };

/** Per-call scratch the streaming path threads from authorize → classify → execute → record. */
interface CallRecord {
  invocation?: ToolInvocation;
  lane?: ExecutionLane;
  /** Set when the call produced a real (executed) result. */
  ran?: boolean;
  /** Set for blocked/synthetic/denied calls, telling the recorder how to render. */
  blockedRender?: BlockRender;
}

export interface ProcessorParams {
  deps: AgentDeps;
  ctx: ToolContext;
  mode: ApprovalMode;
  messages: AgentMessage[];
  state: ToolLoopState;
}

function errResult(output: string): ToolResult {
  return { output, isError: true };
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Classify a built invocation into an execution lane (pure). */
export function laneFor(invocation: ToolInvocation): ExecutionLane {
  return invocation.kind === "read-only" || invocation.kind === "session" ? "read" : "exclusive";
}

/**
 * Coordinates one assistant turn's tool calls. A fresh instance is created per
 * turn (so `records` is per-turn), but it mutates the run-scoped `state`.
 */
export class ToolCallProcessor {
  readonly deps: AgentDeps;
  readonly ctx: ToolContext;
  readonly mode: ApprovalMode;
  readonly messages: AgentMessage[];
  readonly state: ToolLoopState;

  /** Per-call scratch keyed by call id (streaming path). */
  private readonly records = new Map<string, CallRecord>();
  /** In-flight read executions, awaited before an exclusive call runs (drain-before-exclusive). */
  private readonly inFlightReads = new Set<Promise<void>>();
  /** Set when a repeated-invalid-args stop is requested mid-stream. */
  stopRequested = false;

  constructor(p: ProcessorParams) {
    this.deps = p.deps;
    this.ctx = p.ctx;
    this.mode = p.mode;
    this.messages = p.messages;
    this.state = p.state;
  }

  private recordFor(call: ToolCall): CallRecord {
    let rec = this.records.get(call.id);
    if (!rec) {
      rec = {};
      this.records.set(call.id, rec);
    }
    return rec;
  }

  // ── Phase 1: authorize ──────────────────────────────────────────────────────

  /**
   * Build + gate a call: unknown-tool, deferred-unexposed, invalid-args,
   * permission deny, ask-approval, and PreToolUse hook. Returns an invocation to
   * execute, a blocked synthetic/denied result, or a full-run stop. Mirrors the
   * original serial body 1:1.
   */
  async authorize(call: ToolCall): Promise<Authorization> {
    const { deps, ctx, mode, state } = this;

    const tool = deps.registry.get(call.name);
    if (!tool) {
      return { kind: "blocked", render: "synthetic", result: errResult(`Unknown tool "${call.name}".`) };
    }
    // Deferred tool schemas: a deferred tool whose schema was never exposed must
    // not execute (provider quirk / stale state / injection).
    if (deps.registry.isDeferredUnexposed(call.name)) {
      return {
        kind: "blocked",
        render: "synthetic",
        result: errResult(
          `Tool "${call.name}" is available but its schema has not been loaded. Call tool_search first.`,
        ),
      };
    }

    let invocation: ToolInvocation;
    try {
      invocation = tool.build(call.arguments);
      state.lastInvalidSignature = null;
    } catch (err) {
      if (err instanceof InvalidArgumentsError) {
        const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
        if (signature === state.lastInvalidSignature) {
          deps.onNotice?.(`Stopping: ${call.name} called with invalid arguments repeatedly.`);
          return { kind: "stop" };
        }
        state.lastInvalidSignature = signature;
        return { kind: "blocked", render: "synthetic", result: errResult(err.message) };
      }
      throw err;
    }

    const decision = checkPermission(invocation, mode, { mcpExecuteEnabled: deps.mcpExecuteEnabled });
    if (decision === "deny") {
      return {
        kind: "blocked",
        render: { denied: invocation.describe() },
        result: errResult(
          `Denied by permission policy (mode: ${mode}). This action was not run. ` +
            `Do not attempt to bypass this gate. If the capability is essential to the task, stop and explain to the user why you are blocked.`,
        ),
      };
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
        return {
          kind: "blocked",
          render: "synthetic",
          result: errResult(
            "User rejected this action. It was not run. Do not retry it — propose a safe alternative or ask the user how to proceed.",
          ),
        };
      }
    }

    // PreToolUse hooks fire only after the policy allowed/approved the tool, so a
    // hook deny is additive (it can never resurrect a policy-denied tool).
    if (deps.onPreToolUse) {
      let outcome: import("../hooks/types.js").HookOutcome | undefined;
      try {
        outcome = await deps.onPreToolUse(call.name, invocation, ctx);
      } catch (err) {
        deps.onNotice?.(`hook PreToolUse error: ${msg(err)}`);
        outcome = undefined;
      }
      if (outcome?.decision === "deny") {
        return {
          kind: "blocked",
          render: { denied: invocation.describe() },
          result: errResult(`Blocked by hook: ${outcome.reason ?? "denied"}. This action was not run.`),
        };
      }
    }

    return { kind: "execute", invocation };
  }

  // ── Phase 2: execute ────────────────────────────────────────────────────────

  /**
   * Copy-on-write provisioning + the real `invocation.execute(ctx)`. A
   * provisioning failure becomes a recoverable synthetic result; a user abort
   * stops the run. Mirrors the original serial body 1:1 (the `signal` argument is
   * accepted for the executor seam but tools observe `ctx.signal`, which is linked
   * to it).
   */
  async execute(call: ToolCall, invocation: ToolInvocation): Promise<Execution> {
    const { deps, ctx } = this;

    // Copy-on-write: on the FIRST write-effect tool, provision a disposable
    // worktree and redirect ctx.workspaceRoot. Runs after the gate so a denied /
    // blocked / rejected write never creates one; a failure becomes a recoverable
    // tool-result.
    if (deps.ensureWritableRoot) {
      try {
        await deps.ensureWritableRoot(invocation);
      } catch (err) {
        return { kind: "blocked", result: errResult(`Cannot start writing: ${msg(err)}`) };
      }
    }

    deps.onToolCall?.(call.name, invocation.describe());
    let result: ToolResult;
    try {
      result = await invocation.execute(ctx);
    } catch (err) {
      // An abort must stop the whole run, not be swallowed as a recoverable error.
      if (ctx.signal.aborted || (err as Error).name === "AbortError") {
        return { kind: "abort" };
      }
      result = { output: `Tool ${call.name} failed: ${msg(err)}`, isError: true };
    }
    return { kind: "ran", result };
  }

  // ── Phase 3: record ─────────────────────────────────────────────────────────

  /**
   * Record a blocked (non-executing) call into history and fire the matching
   * renderer callbacks. `synthetic` → `onToolResult` + push; `denied` →
   * `onToolCall(describe)` + push. Mirrors the original serial blocked branches.
   */
  async recordBlocked(call: ToolCall, render: BlockRender, result: ToolResult): Promise<void> {
    const { deps, messages } = this;
    if (render === "synthetic") {
      pushSyntheticToolResult(messages, deps, call.id, call.name, result.output);
    } else {
      deps.onToolCall?.(call.name, render.denied);
      pushToolResult(messages, call.id, call.name, result.output);
    }
    await deps.onPersist?.();
  }

  /**
   * Record a real (executed) result into history and run all post-result side
   * effects: onToolResult, model escalation, read-budget tracking + offload,
   * persistence, the one-shot read-budget nudge, PostToolUse hooks, post-write
   * diagnostics, and format-on-edit. Mirrors the original serial body 1:1.
   */
  async recordRanResult(call: ToolCall, invocation: ToolInvocation, result: ToolResult): Promise<void> {
    const { deps, ctx, messages, state } = this;

    deps.onToolResult?.(call.name, result);

    // Model escalation: the SAME tool failing the SAME way twice in a row switches
    // to a stronger model for the rest of the run.
    if (result.isError) {
      const sig = `${call.name}:${result.output.slice(0, 80)}`;
      if (sig === state.lastToolErrorSig) {
        const escalated = deps.onRepeatedToolError?.();
        if (escalated) state.curModel = escalated;
        state.lastToolErrorSig = null; // fire once per streak
      } else {
        state.lastToolErrorSig = sig;
      }
    } else {
      state.lastToolErrorSig = null;
    }

    state.readBytes += result.output.length;
    if (result.output.length > MAX_TOOL_RESULT_BYTES) {
      const id = await saveManagedOutput(ctx.workspaceRoot, result.output);
      const preview = result.output.slice(0, MAX_TOOL_RESULT_BYTES);
      const dropped = result.output.length - MAX_TOOL_RESULT_BYTES;
      const content =
        preview +
        `\n\n[... tool result truncated: ${dropped} of ${result.output.length} bytes omitted to fit context budget ...]\n` +
        `Complete output offloaded to disk.\n` +
        `Output ID: ${id}\n` +
        `Use read_managed_output(outputId: "${id}", startLine: X, endLine: Y) to read specific ranges.`;
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    } else {
      pushToolResult(messages, call.id, call.name, result.output);
    }
    await deps.onPersist?.();

    // One-shot read-budget focus nudge.
    if (!state.nudged) {
      const bytes = state.readBytes;
      if (bytes >= READ_BUDGET_NUDGE_BYTES) {
        state.nudged = true;
        const approxTokens = Math.round(bytes / 4 / 1000);
        messages.push({
          role: "system",
          content:
            `You have read a large amount of file content (~${approxTokens}k tokens) without converging. ` +
            `Narrow your hypothesis: use grep/repo_map and read only the specific lines you need ` +
            `(read_file offset/limit) instead of whole files. Do not re-read files already in context.`,
        });
        deps.onNotice?.(
          `Read-budget nudge: ~${approxTokens}k tokens of file content read — asked the model to narrow its focus.`,
        );
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

    // Post-write diagnostics. Only on SUCCESSFUL mutate tools.
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

  // ── Streaming-executor seams ────────────────────────────────────────────────
  //
  // These wrap the phase helpers above for `StreamingToolExecutor`. The executor
  // calls authorize → classify → execute per call (authorize/classify strictly in
  // call order; read executes run concurrently in the background). Per-call scratch
  // is threaded through `records` so the ordered recorder can render correctly.

  /** Authorize seam: run the gate, stash the invocation/render, report ok/blocked. */
  async authorizeForExecutor(call: ToolCall): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
    const rec = this.recordFor(call);
    const auth = await this.authorize(call);
    if (auth.kind === "stop") {
      // Mid-stream we cannot unwind the assistant turn; record a synthetic block
      // and ask the loop to stop after the ordered drain.
      this.stopRequested = true;
      rec.ran = false;
      rec.blockedRender = "synthetic";
      return {
        ok: false,
        result: errResult(`Stopping: ${call.name} called with invalid arguments repeatedly.`),
      };
    }
    if (auth.kind === "blocked") {
      rec.ran = false;
      rec.blockedRender = auth.render;
      return { ok: false, result: auth.result };
    }
    rec.invocation = auth.invocation;
    return { ok: true };
  }

  /** Classify seam: lane from the stashed invocation (null only if unbuilt). */
  classifyForExecutor(call: ToolCall): ExecutionLane | null {
    const rec = this.records.get(call.id);
    if (!rec?.invocation) return null;
    rec.lane = laneFor(rec.invocation);
    return rec.lane;
  }

  /**
   * Execute seam: enforce drain-before-exclusive, then run the call. Read-lane
   * calls register an in-flight promise so a later exclusive can wait for them to
   * settle before its copy-on-write/execution touches the tree.
   */
  async executeForExecutor(call: ToolCall, _signal: AbortSignal): Promise<ToolResult> {
    const rec = this.records.get(call.id);
    const invocation = rec?.invocation;
    if (!rec || !invocation) {
      // Should not happen (classify guards it) — defensive synthetic result.
      return errResult(`Tool "${call.name}" was not authorized for execution.`);
    }

    if (rec.lane === "exclusive") {
      // Drain-before-exclusive: a mutate/execute call must not run (and its
      // copy-on-write provisioning must not switch the workspace root) while an
      // earlier read is still touching the tree.
      await this.drainReads();
      return this.runExecute(call, rec, invocation);
    }

    // Read lane: track the in-flight execution so a later exclusive can drain it.
    let done!: () => void;
    const tracked = new Promise<void>((resolve) => (done = resolve));
    this.inFlightReads.add(tracked);
    try {
      return await this.runExecute(call, rec, invocation);
    } finally {
      this.inFlightReads.delete(tracked);
      done();
    }
  }

  private async runExecute(call: ToolCall, rec: CallRecord, invocation: ToolInvocation): Promise<ToolResult> {
    const exec = await this.execute(call, invocation);
    if (exec.kind === "abort") {
      // User abort during execution. The executor records this; the loop detects
      // ctx.signal.aborted afterward and stops the run.
      rec.ran = false;
      rec.blockedRender = "synthetic";
      return errResult("Aborted.");
    }
    if (exec.kind === "blocked") {
      rec.ran = false;
      rec.blockedRender = "synthetic";
      return exec.result;
    }
    rec.ran = true;
    return exec.result;
  }

  private async drainReads(): Promise<void> {
    if (this.inFlightReads.size === 0) return;
    await Promise.allSettled([...this.inFlightReads]);
  }

  /**
   * Record one ordered executor update into history. Called strictly in
   * call-index order by the streaming loop, so history append order matches the
   * assistant's tool-call order (keeps `sanitizeForProvider` valid).
   */
  async recordUpdate(call: ToolCall, result: ToolResult): Promise<void> {
    const rec = this.records.get(call.id);
    if (rec?.ran) {
      await this.recordRanResult(call, rec.invocation!, result);
    } else {
      await this.recordBlocked(call, rec?.blockedRender ?? "synthetic", result);
    }
  }
}

// ── history push helpers (moved verbatim from agentLoop) ──────────────────────

export function pushToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  name: string,
  content: string,
): void {
  messages.push({ role: "tool", toolCallId, name, content: capToolResult(content) });
}

/**
 * Like {@link pushToolResult}, but also fires the `onToolResult` renderer callback
 * so synthetic outcomes (unknown tool, invalid args, ask rejected) render a tool
 * block. Fires ONLY `onToolResult` — never `onToolCall` (which feeds the subagent
 * runner's security record of tools actually dispatched).
 */
export function pushSyntheticToolResult(
  messages: AgentMessage[],
  deps: AgentDeps,
  toolCallId: string,
  name: string,
  content: string,
): void {
  deps.onToolResult?.(name, { output: content, isError: true });
  pushToolResult(messages, toolCallId, name, content);
}

/** Render a DiagnosticRun into a human-readable notice for the model. */
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

// ── env gating ────────────────────────────────────────────────────────────────

/** True when an env var is set to an affirmative value (1/true/yes/on). */
export function envFlagOn(value: string | undefined): boolean {
  if (!value) return false;
  const s = value.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Read-lane concurrency cap from `DEEPCODER_TOOL_READ_CONCURRENCY` (default 4). */
export function readConcurrencyFromEnv(): number {
  const raw = process.env.DEEPCODER_TOOL_READ_CONCURRENCY;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}
