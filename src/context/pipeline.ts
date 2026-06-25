import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import { estimateMessages } from "./tokenBudget.js";
import { compactIfNeeded, chooseTailMessages, type CompactResult } from "./compaction.js";
import type { ContextStageStats } from "./queryProjection.js";
import { indexToolCalls, isExploreTool, pathArg, lastErrorIndex } from "./tridentUtil.js";

/**
 * Five-stage pre-model context pipeline (the umbrella that sequences the
 * deterministic context shapers in a fixed order, cheapest/least-lossy first):
 *
 *   1. Budget reduce   cap oversized individual tool artifacts (flag, default off)
 *   2. Trident reduce  remove/stub redundant or obsolete history  (inside compactIfNeeded)
 *   3. Snip tail       cheap temporal trim of old read-only exploration (flag, default off)
 *   5. Auto compact    deterministic summary as the last resort   (inside compactIfNeeded)
 *
 * (Stage 4 "context collapse" needs the append-oriented session log and is not
 * yet wired — it stays disabled.) With the optional stages off, this is
 * byte-identical to calling `compactIfNeeded` directly, so the default rollout is
 * a no-op shell. Every stage is pure (no LLM/Date/random), monotonic (never grows
 * tokens), pairing-safe, and leaves `messages[0]`/system messages untouched.
 */
export interface ContextPipelineFeatures {
  budgetReduce: boolean;
  snip: boolean;
  autoCompact: boolean;
}

export interface ContextPipelineOptions {
  budgetTokens: number;
  compactAt: number;
  todos: Todo[];
  readTracker: Set<string>;
  writeTracker: Set<string>;
  force?: boolean;
  /** Trident toggle, passed through to compactIfNeeded (undefined → env default). */
  trident?: boolean;
  features: ContextPipelineFeatures;
  /** Stage-1 soft cap (bytes) for an oversized tool result. */
  softCapBytes?: number;
}

export interface ContextPipelineResult {
  /** The delegated compaction result (drives the loop's notice/epoch/persist). */
  compaction: CompactResult;
  stages: ContextStageStats[];
  before: number;
  after: number;
  changed: boolean;
  compacted: boolean;
}

const OFFLOAD_MARKERS = ["Output ID:", "tool result truncated"];

/**
 * Stage 1 — Budget reduce. Cap an oversized *individual* tool result (content
 * only; pairing-safe) so one giant artifact doesn't force whole-history
 * compaction. Idempotent: a result already offloaded/capped (carries a marker)
 * or under the soft cap is left untouched. Never touches system/user/assistant.
 */
export function budgetReduce(messages: AgentMessage[], head: number, softCapBytes: number): boolean {
  let changed = false;
  for (let i = head; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || typeof m.content !== "string") continue;
    if (m.content.length <= softCapBytes) continue;
    if (OFFLOAD_MARKERS.some((marker) => m.content.includes(marker))) continue; // already reduced
    const dropped = m.content.length - softCapBytes;
    const next = `${m.content.slice(0, softCapBytes)}\n\n[... tool result truncated: ${dropped} of ${m.content.length} bytes omitted to fit the context budget ...]`;
    if (next.length < m.content.length) {
      messages[i] = { ...m, content: next };
      changed = true;
    }
  }
  return changed;
}

/**
 * Stage 3 — Snip tail. A cheap temporal trim: when still over budget after
 * Trident+compaction, stub the *content* of old read-only exploration results
 * (read_file/grep/glob/list_dir) in the compactible region with a one-line note,
 * preserving the protected recent tail and never touching the last error. Lossier
 * than supersede (it stubs even non-obsolete reads), hence a later, flagged stage.
 */
export function snipTail(messages: AgentMessage[], head: number, opts: ContextPipelineOptions): boolean {
  const tailStart = chooseTailMessages(messages, head, opts.budgetTokens * 0.3);
  if (tailStart - head < 1) return false;
  const idx = indexToolCalls(messages);
  const protectedError = lastErrorIndex(messages);
  let changed = false;
  for (let i = head; i < tailStart; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || !m.toolCallId || i === protectedError) continue;
    const info = idx.get(m.toolCallId);
    if (!info || !isExploreTool(info.name)) continue;
    const p = pathArg(info.args);
    const label = `[snipped ${info.name}${p ? ` ${p}` : ""} — older exploration omitted from this call]`;
    if (typeof m.content === "string" && label.length < m.content.length) {
      messages[i] = { ...m, content: label };
      changed = true;
    }
  }
  return changed;
}

export function shapeContextBeforeModel(messages: AgentMessage[], opts: ContextPipelineOptions): ContextPipelineResult {
  const stages: ContextStageStats[] = [];
  const before = estimateMessages(messages);
  const head = messages[0]?.role === "system" ? 1 : 0;

  // Stage 1 — budget reduce (off by default).
  if (opts.features.budgetReduce) {
    const b = estimateMessages(messages);
    const changed = budgetReduce(messages, head, opts.softCapBytes ?? 16_000);
    stages.push({ stage: "budget-reduce", before: b, after: estimateMessages(messages), changed });
  }

  // Stage 2 + Stage 5 — Trident reduce then deterministic auto-compact summary.
  const compactBefore = estimateMessages(messages);
  const compaction: CompactResult = opts.features.autoCompact
    ? compactIfNeeded(messages, {
        budgetTokens: opts.budgetTokens,
        compactAt: opts.compactAt,
        todos: opts.todos,
        readTracker: opts.readTracker,
        writeTracker: opts.writeTracker,
        force: opts.force,
        trident: opts.trident,
      })
    : { compacted: false, before: compactBefore, after: compactBefore };
  if (compaction.trident) {
    // Informational sub-breakdown of the compaction stage.
    stages.push({
      stage: "trident",
      before: compaction.before,
      after: compaction.before - compaction.trident.saved,
      changed: compaction.trident.changed,
    });
  }
  stages.push({ stage: "auto-compact", before: compaction.before, after: compaction.after, changed: compaction.compacted });

  // Stage 3 — snip (off by default); only when still over budget, never on force.
  let snipChanged = false;
  if (opts.features.snip && !opts.force) {
    const b = estimateMessages(messages);
    if (b > opts.budgetTokens * opts.compactAt) snipChanged = snipTail(messages, head, opts);
    stages.push({ stage: "snip", before: b, after: estimateMessages(messages), changed: snipChanged });
  }

  const after = estimateMessages(messages);
  return {
    compaction,
    stages,
    before,
    after,
    changed: compaction.compacted || snipChanged || after < before,
    compacted: compaction.compacted,
  };
}
