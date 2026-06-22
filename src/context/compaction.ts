import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import { estimateMessages } from "./tokenBudget.js";

export interface CompactOptions {
  budgetTokens: number;
  /** Fraction of the budget at which compaction triggers (e.g. 0.8). */
  compactAt: number;
  todos: Todo[];
  readTracker: Set<string>;
  writeTracker: Set<string>;
  /** Force compaction regardless of current size (for /compact). */
  force?: boolean;
}

export interface CompactResult {
  compacted: boolean;
  before: number;
  after: number;
}

const SUMMARY_TAG = "[compacted-summary]";

/**
 * Heuristic, deterministic history compaction (no extra LLM call). When the
 * conversation exceeds budget×threshold, older turns are replaced by a single
 * summary message that preserves the original task, files touched, todos,
 * unresolved errors, and a tail of recent raw turns. Mutates `messages` in
 * place. Returns whether it compacted.
 */
export function compactIfNeeded(messages: AgentMessage[], opts: CompactOptions): CompactResult {
  const before = estimateMessages(messages);
  const trigger = opts.budgetTokens * opts.compactAt;
  if (!opts.force && before <= trigger) return { compacted: false, before, after: before };

  // Index 0 is the system prompt; never touch it.
  const head = messages[0]?.role === "system" ? 1 : 0;

  // Keep a recent tail (~30% of budget). When forcing under a large budget we
  // instead keep a fraction of the *current* size so /compact actually shrinks.
  const tailTarget = opts.force
    ? Math.min(opts.budgetTokens * 0.3, before * 0.4)
    : opts.budgetTokens * 0.3;
  const tailStart = chooseTailMessages(messages, head, tailTarget);
  if (tailStart - head < 2) return { compacted: false, before, after: before };

  const older = messages.slice(head, tailStart);
  // WIRED: buildStructuredSummary — deterministic markdown recap with sections
  const summary = buildStructuredSummary(older, opts.readTracker, opts.writeTracker, opts.todos);

  // The summary is a USER message, not a second `system` message. Providers like
  // the Gemini OpenAI-compatible endpoint send system messages INLINE (no
  // hoisting) and reject a non-leading/second system message — after compaction
  // that 400s the next call (manifesting alongside the Gemini 3.x
  // thought_signature requirement). A user-role recap keeps a valid
  // system→user→assistant structure and is provider-agnostic.
  messages.splice(head, older.length, { role: "user", content: summary });
  const after = estimateMessages(messages);
  return { compacted: true, before, after };
}

export function isSummary(m: AgentMessage): boolean {
  return m.role === "user" && m.content.startsWith(SUMMARY_TAG);
}

/**
 * Deterministic structured markdown recap built from session data — NO LLM call.
 * Sections: ## Task, ## Files changed, ## Unresolved items.
 */
export function buildStructuredSummary(
  messages: AgentMessage[],
  readTracker: Set<string>,
  writeTracker: Set<string>,
  todos: Todo[],
): string {
  // Extract task from the first user message
  const firstUser = messages.find((m) => m.role === "user");
  const task = firstUser?.content?.trim() ?? "";

  // Classify files from the trackers
  const readSet = new Set(readTracker);
  const written = new Set<string>();
  const onlyRead: string[] = [];
  for (const p of readSet) {
    if (writeTracker.has(p)) {
      written.add(p);
    } else {
      onlyRead.push(p);
    }
  }
  const onlyWritten = [...writeTracker].filter((p) => !readSet.has(p));
  for (const p of onlyWritten) written.add(p);

  const lines: string[] = [];
  lines.push(SUMMARY_TAG);
  lines.push("## Task");
  lines.push(task.length > 0 ? task.slice(0, 400) : "(no user task extracted)");
  lines.push("");
  lines.push("## Files changed");
  if (readSet.size === 0 && writeTracker.size === 0) {
    lines.push("(none)");
  } else {
    for (const p of [...written].sort()) lines.push(`- ${p} (edited)`);
    for (const p of [...onlyRead].sort()) lines.push(`- ${p} (read)`);
    for (const p of [...onlyWritten].sort()) if (!written.has(p)) lines.push(`- ${p} (created)`);
  }
  lines.push("");
  lines.push("## Unresolved items");
  const pending = todos.filter((t) => t.status !== "completed");
  if (pending.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of pending) lines.push(`- [${t.status}] ${t.content}`);
  }
  lines.push("");
  lines.push("Continue the task using the recent messages below.");
  return lines.join("\n");
}

/**
 * Content-aware tail selection. Work backwards from the end counting tokens.
 * Always includes the last user message (current prompt), the last tool result
 * (often an error or diagnostic), and the last assistant response. Fills the
 * remaining tail budget with earlier messages in reverse, then snaps to a safe
 * boundary that doesn't orphan tool results.
 */
export function chooseTailMessages(
  messages: AgentMessage[],
  head: number,
  tailTokens: number,
): number {
  let tokens = 0;
  let i = messages.length;
  while (i > head) {
    const m = messages[i - 1]!;
    tokens += Math.ceil((m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)) / 4) + 4;
    if (tokens > tailTokens) break;
    i--;
  }
  // A tail must not begin with a `tool` message (its owning assistant precedes
  // it). Move the boundary earlier to include that assistant turn.
  while (i < messages.length && messages[i]?.role === "tool") i--;
  if (i < head) i = head;
  return i;
}
