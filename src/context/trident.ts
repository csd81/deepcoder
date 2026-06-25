import type { AgentMessage } from "../providers/types.js";
import { estimateMessages } from "./tokenBudget.js";
import { supersede } from "./supersede.js";
import { collapse } from "./collapse.js";
import { cluster } from "./cluster.js";

/**
 * Trident — a deterministic, lossless-ish redundancy pass that runs *before*
 * the summarization fallback in `compactIfNeeded`. It sheds turns that are
 * provably obsolete or duplicative (fossil reads, redundant searches,
 * failed-then-fixed runs, pure-exploration runs, repeated identical failures),
 * often dropping enough tokens that summarization never has to run — preserving
 * far more verbatim recent context.
 *
 * Pure: no LLM, no Date/random. Idempotent and monotonic (never grows tokens).
 * Operates only on the compactible region `[head, tailStart)`; `messages[0]` and
 * every `role:"system"` message are untouchable (the stages only ever touch
 * `role:"tool"` content or remove paired assistant+tool explore groups).
 */
export interface TridentStats {
  changed: boolean;
  /** ~chars shed by each stage (token accounting is `before-after`). */
  superseded: number;
  collapsed: number;
  clustered: number;
  /** Real token delta over the whole pass. */
  saved: number;
  /** Tail boundary after collapse shrank the region. */
  newTailStart: number;
}

function clusterEnabled(): boolean {
  const env = process.env.DEEPCODER_TRIDENT_CLUSTER;
  return !(env === "0" || env === "off" || env === "false");
}

export function reduceWithTrident(
  messages: AgentMessage[],
  head: number,
  tailStart: number,
  opts: { writeTracker: Set<string> },
): TridentStats {
  const before = estimateMessages(messages);

  // Stage 1: supersede — content-only, length unchanged.
  const s1 = supersede(messages, { start: head, end: tailStart }, opts.writeTracker);

  // Stage 2: collapse — shrinks the array; track the removal to shift the tail.
  const s2 = collapse(messages, { start: head, end: tailStart });
  const newTailStart = tailStart - (s2.removed ?? 0);

  // Stage 3: cluster — content-only, over the (possibly shrunk) region.
  const s3 = clusterEnabled() ? cluster(messages, { start: head, end: newTailStart }) : { changed: false, saved: 0 };

  const after = estimateMessages(messages);
  return {
    changed: s1.changed || s2.changed || s3.changed,
    superseded: s1.saved,
    collapsed: s2.saved,
    clustered: s3.saved,
    saved: before - after,
    newTailStart,
  };
}
