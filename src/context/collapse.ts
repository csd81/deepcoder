import type { AgentMessage } from "../providers/types.js";

export interface CollapseResult {
  changed: boolean;
  saved: number;
}

/** Rough token estimate for a message. */
function msgTokens(m: AgentMessage): number {
  let chars = m.content.length;
  if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  return Math.ceil(chars / 4) + 4;
}

const EXPLORATION_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);
const EFFECT_TOOLS = new Set(["write_file", "edit_file", "delete_file", "rename_file", "apply_patch", "run_bash"]);

/**
 * Stage 2 — Collapse: fold contiguous runs of pure tool-I/O assistant+tool pairs
 * (read_file/list_dir/glob/grep, no substantive assistant prose, no write/execute
 * effect) into one synthetic user note. Assistant turns AND their tool results are
 * removed together (no orphans). Mutates `messages` in place.
 */
export function collapse(
  messages: AgentMessage[],
  regionStart: number,
  regionEnd: number,
): CollapseResult {
  // First pass: identify all valid exploration pairs.
  interface Pair {
    assistantIdx: number;
    toolEndIdx: number; // inclusive
  }

  const pairs: Pair[] = [];
  let i = regionStart;
  while (i < regionEnd) {
    const m = messages[i]!;
    if (m.role !== "assistant") { i++; continue; }
    if (!isPureExplorationAssistant(m)) { i++; continue; }

    const toolCalls = m.toolCalls!;
    const toolResultIds = new Set(toolCalls.map((c) => c.id));
    let toolEnd = i;
    const seen = new Set<string>();
    for (let j = i + 1; j < regionEnd && seen.size < toolResultIds.size; j++) {
      const tm = messages[j]!;
      if (tm.role === "tool" && tm.toolCallId && toolResultIds.has(tm.toolCallId)) {
        seen.add(tm.toolCallId);
        toolEnd = j;
      } else if (tm.role === "assistant" || tm.role === "user" || tm.role === "system") {
        break;
      }
    }
    if (seen.size === toolResultIds.size) {
      pairs.push({ assistantIdx: i, toolEndIdx: toolEnd });
      i = toolEnd + 1;
    } else {
      i++;
    }
  }

  if (pairs.length < 2) return { changed: false, saved: 0 };

  // Group pairs into contiguous runs (adjacent pairs with no gap between them).
  const runs: { start: number; end: number }[] = []; // indices into `pairs`
  let runStart = 0;
  while (runStart < pairs.length) {
    let runEnd = runStart;
    while (
      runEnd + 1 < pairs.length &&
      pairs[runEnd + 1]!.assistantIdx === pairs[runEnd]!.toolEndIdx + 1
    ) {
      runEnd++;
    }
    if (runEnd > runStart) {
      runs.push({ start: runStart, end: runEnd });
    }
    runStart = runEnd + 1;
  }

  if (runs.length === 0) return { changed: false, saved: 0 };

  let changed = false;
  let saved = 0;

  // Process runs from right to left so indices stay valid after splicing.
  for (let ri = runs.length - 1; ri >= 0; ri--) {
    const r = runs[ri]!;
    const startIdx = pairs[r.start]!.assistantIdx;
    const endIdx = pairs[r.end]!.toolEndIdx;

    // Build the collapse note
    const descriptions: string[] = [];
    let totalCalls = 0;
    for (let p = r.start; p <= r.end; p++) {
      const asst = messages[pairs[p]!.assistantIdx]!;
      if (asst.toolCalls) {
        for (const c of asst.toolCalls) {
          totalCalls++;
          if (c.name === "read_file") {
            const pth = typeof c.arguments.path === "string" ? c.arguments.path : "?";
            descriptions.push(`read ${pth}`);
          } else if (c.name === "list_dir") {
            const pth = typeof c.arguments.path === "string" ? c.arguments.path : ".";
            descriptions.push(`list_dir ${pth}`);
          } else if (c.name === "glob") {
            const ptn = typeof c.arguments.pattern === "string" ? c.arguments.pattern : "?";
            descriptions.push(`glob "${ptn}"`);
          } else if (c.name === "grep") {
            const ptn = typeof c.arguments.pattern === "string" ? c.arguments.pattern : "?";
            descriptions.push(`grep "${ptn}"`);
          }
        }
      }
    }

    const note = `[collapsed ${totalCalls} exploration calls: ${descriptions.join("; ")}]`;

    // Compute tokens saved
    let before = 0;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      before += msgTokens(messages[idx]!);
    }

    // Replace with the single user note
    const count = endIdx - startIdx + 1;
    messages.splice(startIdx, count, { role: "user", content: note });

    const after = msgTokens(messages[startIdx]!);
    saved += Math.max(0, before - after);
    changed = true;
  }

  return { changed, saved };
}

/** An assistant message is a pure exploration turn if it has toolCalls, all of
 *  which are exploration tools, no write/execute tools, and negligible prose. */
function isPureExplorationAssistant(m: AgentMessage): boolean {
  if (!m.toolCalls || m.toolCalls.length === 0) return false;
  if (m.content.trim().length > 0) return false;
  for (const c of m.toolCalls) {
    if (EFFECT_TOOLS.has(c.name)) return false;
    if (!EXPLORATION_TOOLS.has(c.name)) return false;
  }
  return true;
}
