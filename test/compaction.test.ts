import { test } from "node:test";
import assert from "node:assert/strict";
import { compactIfNeeded, isSummary } from "../src/context/compaction.js";
import { estimateMessages } from "../src/context/tokenBudget.js";
import type { AgentMessage } from "../src/providers/types.js";
import type { Todo } from "../src/tools/types.js";

function convo(): AgentMessage[] {
  const big = "x".repeat(4000); // ~1000 tokens each
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "Refactor the auth module" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "src/auth.ts" } }] },
    { role: "tool", toolCallId: "1", name: "read_file", content: big },
    { role: "assistant", content: "", toolCalls: [{ id: "2", name: "edit_file", arguments: { path: "src/auth.ts" } }] },
    { role: "tool", toolCallId: "2", name: "edit_file", content: "Edited src/auth.ts" },
    { role: "assistant", content: "", toolCalls: [{ id: "3", name: "run_bash", arguments: { command: "npm test" } }] },
    { role: "tool", toolCallId: "3", name: "run_bash", content: "Exit code 1\n" + big },
    { role: "assistant", content: "Still working on it: " + big },
    { role: "user", content: "keep going" },
  ];
}

test("compaction is a no-op under budget", () => {
  const msgs = convo();
  const res = compactIfNeeded(msgs, { budgetTokens: 1_000_000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set() });
  assert.equal(res.compacted, false);
});

test("compaction shrinks history and preserves task, files, todos, errors", () => {
  const msgs = convo();
  const before = estimateMessages(msgs);
  const todos: Todo[] = [{ id: "1", content: "finish refactor", status: "in_progress" }];
  const readTracker = new Set(["src/auth.ts"]);
  const writeTracker = new Set(["src/auth.ts"]);
  // Small budget forces compaction.
  const res = compactIfNeeded(msgs, { budgetTokens: 3000, compactAt: 0.8, todos, readTracker, writeTracker });
  assert.equal(res.compacted, true);
  assert.ok(res.after < before);

  const summary = msgs.find(isSummary);
  assert.ok(summary, "a summary message should exist");
  assert.match(summary!.content, /## Task/);
  assert.match(summary!.content, /Refactor the auth module/);
  assert.match(summary!.content, /## Files changed/);
  assert.match(summary!.content, /src\/auth\.ts/);
  assert.match(summary!.content, /## Unresolved items/);
  assert.match(summary!.content, /finish refactor/);
  // The last error must survive compaction (regression guard — see undoApply note).
  assert.match(summary!.content, /Exit code 1/);

  // System prompt stays first; recent user turn is retained.
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[0]!.content, "system prompt");
  assert.equal(msgs[msgs.length - 1]!.content, "keep going");
});

test("compaction never starts the retained tail with an orphan tool message", () => {
  const msgs = convo();
  compactIfNeeded(msgs, { budgetTokens: 2000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set() });
  // After the summary (index 1), the first retained message must not be a tool
  // result without its preceding assistant tool_call.
  const firstRetained = msgs[2];
  assert.notEqual(firstRetained?.role, "tool");
});

test("force compaction works even under budget", () => {
  const msgs = convo();
  const res = compactIfNeeded(msgs, { budgetTokens: 1_000_000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set(), force: true });
  assert.equal(res.compacted, true);
});
