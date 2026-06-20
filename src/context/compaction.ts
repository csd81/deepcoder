import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import { renderTodos } from "../tools/todoWrite.js";
import { estimateMessages } from "./tokenBudget.js";

export interface CompactOptions {
  budgetTokens: number;
  /** Fraction of the budget at which compaction triggers (e.g. 0.8). */
  compactAt: number;
  todos: Todo[];
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
  const tailStart = chooseTailStart(messages, head, tailTarget);
  if (tailStart - head < 2) return { compacted: false, before, after: before };

  const older = messages.slice(head, tailStart);
  const summary = buildSummary(older, opts.todos);

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

/** Walk back from the end accumulating tokens until we hit ~maxTailTokens, then
 *  snap to a safe boundary that doesn't orphan tool results. */
function chooseTailStart(messages: AgentMessage[], head: number, maxTailTokens: number): number {
  let tokens = 0;
  let i = messages.length;
  while (i > head) {
    const m = messages[i - 1]!;
    tokens += Math.ceil((m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)) / 4) + 4;
    if (tokens > maxTailTokens) break;
    i--;
  }
  // A tail must not begin with a `tool` message (its owning assistant precedes
  // it). Move the boundary earlier to include that assistant turn.
  while (i < messages.length && messages[i]?.role === "tool") i--;
  if (i < head) i = head;
  return i;
}

function buildSummary(older: AgentMessage[], todos: Todo[]): string {
  const task = older.find((m) => m.role === "user")?.content?.trim();
  const filesTouched = new Set<string>();
  const errors: string[] = [];

  for (const m of older) {
    for (const tc of m.toolCalls ?? []) {
      if (["read_file", "edit_file", "write_file"].includes(tc.name)) {
        const p = (tc.arguments as { path?: string }).path;
        if (p) filesTouched.add(p);
      }
    }
    if (m.role === "tool" && /(\berror\b|denied|not found|Exit code|rejected)/i.test(m.content)) {
      errors.push(m.content.split("\n")[0]!.slice(0, 160));
    }
  }

  const lines = [SUMMARY_TAG, "Summary of earlier conversation (older turns were compacted):"];
  if (task) lines.push(`- Original task: ${task.slice(0, 400)}`);
  if (filesTouched.size) lines.push(`- Files touched: ${[...filesTouched].join(", ")}`);
  if (todos.length) lines.push(`- Current todos:\n${renderTodos(todos)}`);
  if (errors.length) lines.push(`- Recent unresolved issues:\n${errors.slice(-5).map((e) => `  · ${e}`).join("\n")}`);
  lines.push("Continue the task using the recent messages below.");
  return lines.join("\n");
}
