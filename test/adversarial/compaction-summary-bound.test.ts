/**
 * Token-optimization plan, item 6 — keep the compaction summary tight.
 *
 * Compaction already drops resolved (completed) todos. The remaining unbounded
 * part is the "## Files changed" list: a long session can touch hundreds of
 * files, and an unbounded list bloats the summary — which, since the summary
 * lands in the kept prefix, is carried (and re-billed) every later turn. Bound
 * the list with an explicit marker, matching the outputBound convention.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredSummary } from "../../src/context/compaction.js";
import type { AgentMessage, Todo } from "../../src/providers/types.js";

const taskMsg: AgentMessage[] = [{ role: "user", content: "Refactor the auth module." }];

test("[compaction-files-bounded] a huge changed-file set is capped with an explicit marker", () => {
  const reads = new Set<string>();
  for (let i = 0; i < 200; i++) reads.add(`src/file${i}.ts`);
  const summary = buildStructuredSummary(taskMsg, reads, new Set(), []);

  const fileLines = summary.split("\n").filter((l) => l.startsWith("- src/file"));
  assert.ok(fileLines.length <= 60, `file list should be capped, got ${fileLines.length}`);
  assert.match(summary, /more (files|results)|truncated/i, "explicit truncation marker present");
});

test("[compaction-drops-resolved] completed todos never appear in the summary", () => {
  const todos: Todo[] = [
    { content: "done thing", status: "completed" } as Todo,
    { content: "active thing", status: "in_progress" } as Todo,
  ];
  const summary = buildStructuredSummary(taskMsg, new Set(), new Set(), todos);
  assert.doesNotMatch(summary, /done thing/);
  assert.match(summary, /active thing/);
});

test("[compaction-small-unbounded-marker] a small file set has NO truncation marker", () => {
  const reads = new Set<string>(["a.ts", "b.ts"]);
  const summary = buildStructuredSummary(taskMsg, reads, new Set(), []);
  assert.doesNotMatch(summary, /more files|truncated/i);
  assert.match(summary, /- a\.ts/);
});
