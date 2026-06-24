import type { AgentMessage } from "../providers/types.js";
import { supersede } from "./supersede.js";
import { collapse } from "./collapse.js";

export interface TridentStats {
  /** Stage 1 stats. */
  supersede: { changed: boolean; saved: number };
  /** Stage 2 stats. */
  collapse: { changed: boolean; saved: number };
  /** Total tokens saved by both stages. */
  totalSaved: number;
}

/**
 * Run the Trident compaction pipeline (Stage 1 Supersede + Stage 2 Collapse) over
 * the compactible region. The compactible region is everything in `messages`
 * EXCEPT:
 *   - messages[0] (the system prompt / epoch baseline)
 *   - any role:"system" message (context-update, nudge, PR context)
 *   - the protected recent tail [protectedStart, messages.length)
 *
 * Mutates `messages` in place. Returns aggregate stats. Cluster (Stage 3) is
 * deferred — not called or imported here.
 */
export function reduceWithTrident(
  messages: AgentMessage[],
  protectedStart: number,
  writeTracker: Set<string>,
): TridentStats {
  // Determine the compactible region: skip system messages and the protected tail.
  const region = findCompactibleRegion(messages, protectedStart);
  if (region.length === 0) {
    return {
      supersede: { changed: false, saved: 0 },
      collapse: { changed: false, saved: 0 },
      totalSaved: 0,
    };
  }

  // Process segments from right to left so collapse's splicing doesn't
  // invalidate earlier segment indices. Supersede only mutates content (not
  // array structure), so we can run supersede on all segments first.
  let supersedeChanged = false;
  let supersedeSaved = 0;
  let collapseChanged = false;
  let collapseSaved = 0;

  for (const { start, end } of region) {
    const s = supersede(messages, start, end, writeTracker);
    supersedeChanged = supersedeChanged || s.changed;
    supersedeSaved += s.saved;
  }

  // Recalculate segments after supersede (structure unchanged, but safe).
  // Process right-to-left so splice indices stay valid.
  const region2 = findCompactibleRegion(messages, protectedStart);
  for (let ri = region2.length - 1; ri >= 0; ri--) {
    const { start, end } = region2[ri]!;
    const c = collapse(messages, start, end);
    collapseChanged = collapseChanged || c.changed;
    collapseSaved += c.saved;
  }

  return {
    supersede: { changed: supersedeChanged, saved: supersedeSaved },
    collapse: { changed: collapseChanged, saved: collapseSaved },
    totalSaved: supersedeSaved + collapseSaved,
  };
}

interface Segment {
  start: number; // inclusive
  end: number;   // exclusive
}

/**
 * Walk the messages and return the segments that are eligible for compaction.
 * Excludes messages[0], any role:"system" message, and the tail [protectedStart, len).
 */
function findCompactibleRegion(
  messages: AgentMessage[],
  protectedStart: number,
): Segment[] {
  const segments: Segment[] = [];
  let segStart = -1;

  // messages[0] is always excluded (system prompt / epoch baseline).
  const scanEnd = Math.min(protectedStart, messages.length);

  for (let i = 1; i < scanEnd; i++) {
    const m = messages[i]!;
    if (m.role === "system") {
      // Flush any open segment before this untouchable message
      if (segStart !== -1) {
        segments.push({ start: segStart, end: i });
        segStart = -1;
      }
      continue;
    }
    if (segStart === -1) segStart = i;
  }
  // Flush the last segment
  if (segStart !== -1 && segStart < scanEnd) {
    segments.push({ start: segStart, end: scanEnd });
  }

  return segments;
}
