import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import { estimateMessages } from "./tokenBudget.js";
import { boundLines } from "../tools/outputBound.js";
import { reduceWithTrident, type TridentStats } from "./trident.js";

/**
 * Max file entries listed in a compaction summary. The summary lands in the kept
 * prefix and is re-billed every later turn, so an unbounded list (a session can
 * touch hundreds of files) is dead weight. Edited files are listed first, so the
 * cap preferentially keeps the files the model actually changed.
 */
const MAX_SUMMARY_FILES = 40;

export interface CompactOptions {
  budgetTokens: number;
  /** Fraction of the budget at which compaction triggers (e.g. 0.8). */
  compactAt: number;
  todos: Todo[];
  readTracker: Set<string>;
  writeTracker: Set<string>;
  /** Force compaction regardless of current size (for /compact). */
  force?: boolean;
  /** When false (DEEPCODER_TRIDENT=0), Trident is a byte-identical no-op. */
  tridentEnabled?: boolean;
}

export interface CompactResult {
  compacted: boolean;
  before: number;
  after: number;
  /** Set when Trident ran and made changes. */
  trident?: TridentStats;
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

  // Trident: deterministic redundancy pass BEFORE summarization.
  if (opts.tridentEnabled !== false) {
    const trident = reduceWithTrident(messages, tailStart, opts.writeTracker);
    if (trident.supersede.changed || trident.collapse.changed) {
      const mid = estimateMessages(messages);
      if (mid <= trigger) {
        return { compacted: true, before, after: mid, trident };
      }
      // Trident changed the array; recalculate tailStart for the summarization
      // fallback (indices may have shifted from collapse splicing).
      const newTailStart = chooseTailMessages(messages, head, tailTarget);
      if (newTailStart - head >= 2) {
        const older = messages.slice(head, newTailStart);
        const summary = buildStructuredSummary(older, opts.readTracker, opts.writeTracker, opts.todos);
        messages.splice(head, older.length, { role: "user", content: summary });
        const after2 = estimateMessages(messages);
        return { compacted: true, before, after: after2, trident };
      }
      // Fall through: tail too small after Trident, just return as compacted.
      return { compacted: true, before, after: mid, trident };
    }
    // Trident made no changes — fall through to legacy summarization.
  }

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
 * Pull the original task text out of a prior `[compacted-summary]` body — the
 * lines under its `## Task` heading, up to the next `##` section. Lets a second
 * compaction carry the real task forward instead of re-wrapping the summary tag.
 */
export function extractTaskFromSummary(summary: string): string {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Task");
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) break;
    body.push(lines[i]!);
  }
  return body.join("\n").trim();
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
  // Extract task from the first user message. On a re-compaction the first user
  // message IS a prior [compacted-summary]; re-wrapping it would make the "task"
  // the summary tag and lose the real task. Recover the original task from
  // inside that prior summary's ## Task section instead.
  const firstUser = messages.find((m) => m.role === "user");
  const task = firstUser
    ? isSummary(firstUser)
      ? extractTaskFromSummary(firstUser.content)
      : firstUser.content.trim()
    : "";

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
    // Edited first (most important), then read, then created — boundLines caps
    // the combined list with an explicit "(N of M files shown; truncated)".
    const fileLines: string[] = [];
    for (const p of [...written].sort()) fileLines.push(`- ${p} (edited)`);
    for (const p of [...onlyRead].sort()) fileLines.push(`- ${p} (read)`);
    for (const p of [...onlyWritten].sort()) if (!written.has(p)) fileLines.push(`- ${p} (created)`);
    lines.push(...boundLines(fileLines, MAX_SUMMARY_FILES, "files"));
  }
  lines.push("");
  lines.push("## Unresolved items");
  const pending = todos.filter((t) => t.status !== "completed");
  // Preserve the last error/diagnostic too (the legacy compaction kept this — the
  // model needs the most recent failure to keep solving).
  const lastError = [...messages].reverse().find(
    (m) => typeof m.content === "string" && /\b(error|exit code [1-9]|failed|exception|traceback)\b/i.test(m.content),
  );
  if (pending.length === 0 && !lastError) {
    lines.push("(none)");
  } else {
    for (const t of pending) lines.push(`- [${t.status}] ${t.content}`);
    if (lastError && typeof lastError.content === "string") {
      lines.push(`- last error: ${lastError.content.slice(0, 300).replace(/\s+/g, " ").trim()}`);
    }
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
