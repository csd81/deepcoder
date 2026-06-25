import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import type { AgentDeps } from "../agent/agentLoop.js";
import { renderTodos } from "../tools/todoWrite.js";
import type { CompactResult } from "./compaction.js";
import { shapeContextBeforeModel } from "./pipeline.js";
import { estimateMessages } from "./tokenBudget.js";

/**
 * Per-stage token accounting for the pre-model projection. Additive
 * observability that did not exist before this seam — consumed later by the
 * five-stage pipeline and a `/context report`. `changed` is true when the stage
 * altered *durable* (`session.messages`) state.
 */
export interface ContextStageStats {
  stage: string;
  before: number;
  after: number;
  changed: boolean;
}

export interface QueryProjectionInput {
  /** Canonical session history. Durable stages mutate this in place. */
  messages: AgentMessage[];
  ctx: ToolContext;
  deps: AgentDeps;
}

export interface QueryProjection {
  /** Per-call provider input — a fresh array, never persisted. */
  messagesForQuery: AgentMessage[];
  /** Compaction result, surfaced so the loop can drive notice/epoch/persist. */
  compaction: CompactResult;
  /** True when reconciliation appended `[context-update]` messages (→ persist). */
  contextUpdatesAppended: boolean;
  stageStats: ContextStageStats[];
}

/**
 * Append ephemeral context (todo list + newly-relevant JIT path-local
 * instructions + a one-shot delegation-assessment hint + ACE playbook blocks)
 * for the upcoming model call, without mutating persisted history. JIT blocks
 * are pulled once via `deps.jitContext()`; the delegation hint via
 * `deps.delegationHint()`; the playbook via `deps.playbookContext()`. Returns a
 * NEW array when anything is appended, else the input array unchanged.
 */
export function withEphemeralContext(
  messages: AgentMessage[],
  ctx: ToolContext,
  deps: AgentDeps,
): AgentMessage[] {
  const extra: AgentMessage[] = [];
  if (ctx.todos.length > 0) {
    extra.push({ role: "system", content: `Current todo list:\n${renderTodos(ctx.todos)}` });
  }
  for (const block of deps.jitContext?.() ?? []) {
    extra.push({ role: "system", content: block });
  }
  for (const block of deps.delegationHint?.() ?? []) {
    extra.push({ role: "system", content: block });
  }
  for (const block of deps.playbookContext?.() ?? []) {
    extra.push({ role: "system", content: block });
  }
  return extra.length ? [...messages, ...extra] : messages;
}

/**
 * The single pre-model projection chokepoint: canonical `messages` →
 * `messagesForQuery`. Runs the durable stages (deterministic compaction, then
 * cache-optimized context reconciliation) that mutate session history in place,
 * then layers projection-only ephemeral context onto a fresh array. The async
 * durable side-effects (`onContextEpochReset`, `onPersist`) stay in the caller,
 * driven by the returned `compaction`/`contextUpdatesAppended` flags, so this
 * builder is sync and persistence ordering is unchanged.
 *
 * This is the seam every future shaper (Trident, snip, context collapse,
 * deferred-tool catalogs, reactive overflow recovery) hooks into. Today it is a
 * behavior-identical relocation of the steps previously inlined in the loop.
 */
export function buildMessagesForQuery(input: QueryProjectionInput): QueryProjection {
  const { messages, ctx, deps } = input;
  const stageStats: ContextStageStats[] = [];

  // Durable stage 1: the five-stage context pipeline (budget-reduce → Trident →
  // snip → auto-compact). With the optional stages off (default) this is exactly
  // today's `compactIfNeeded`. Mutates `messages` in place.
  const pipeline = shapeContextBeforeModel(messages, {
    budgetTokens: deps.contextBudgetTokens,
    compactAt: deps.compactAt,
    todos: ctx.todos,
    readTracker: ctx.readTracker,
    writeTracker: ctx.writeTracker ?? new Set(),
    trident: deps.tridentCompaction,
    features: deps.contextPipeline ?? { budgetReduce: false, snip: false, autoCompact: true },
  });
  const compaction = pipeline.compaction;
  stageStats.push(...pipeline.stages);

  // Durable stage 2: cache-optimized context reconciliation. Appends at most one
  // `[context-update]` system message at the tail when a dynamic source changed,
  // leaving messages[0] (the cached prefix) untouched.
  const updates = deps.reconcileContext?.() ?? [];
  const reconcileBefore = compaction.after;
  if (updates.length) messages.push(...updates);
  stageStats.push({
    stage: "reconcile",
    before: reconcileBefore,
    after: updates.length ? reconcileBefore + estimateMessages(updates) : reconcileBefore,
    changed: updates.length > 0,
  });

  // Projection-only stage: ephemeral context onto a fresh array (never persisted).
  const messagesForQuery = withEphemeralContext(messages, ctx, deps);

  return {
    messagesForQuery,
    compaction,
    contextUpdatesAppended: updates.length > 0,
    stageStats,
  };
}
