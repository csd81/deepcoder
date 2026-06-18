import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForProvider } from "../../src/agent/agentLoop.js";
import { compactIfNeeded } from "../../src/context/compaction.js";
import type { AgentMessage } from "../../src/providers/types.js";

/** Asserts no dangling tool-call references remain in the message list. */
function assertWellFormed(messages: AgentMessage[]): void {
  const resultIds = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  const callIds = new Set<string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) callIds.add(c.id);
  for (const m of messages) {
    if (m.role === "tool") assert.ok(callIds.has(m.toolCallId!), `orphan tool result ${m.toolCallId}`);
    for (const c of m.toolCalls ?? []) assert.ok(resultIds.has(c.id), `tool call ${c.id} missing its result`);
  }
}

test("sanitizeForProvider drops an assistant tool-call whose result was compacted away", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: {} }] },
    // its tool result (id 1) is gone — simulating compaction having removed it
    { role: "user", content: "next" },
  ];
  const safe = sanitizeForProvider(messages);
  assertWellFormed(safe);
  // the dangling assistant turn is dropped (no content, no valid calls)
  assert.ok(!safe.some((m) => m.role === "assistant" && m.toolCalls));
});

test("sanitizeForProvider drops an orphan tool result with no owning assistant call", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "tool", toolCallId: "99", name: "read_file", content: "leftover" },
    { role: "user", content: "hi" },
  ];
  const safe = sanitizeForProvider(messages);
  assertWellFormed(safe);
  assert.ok(!safe.some((m) => m.role === "tool"));
});

test("sanitizeForProvider keeps a complete assistant/tool group intact", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: {} }] },
    { role: "tool", toolCallId: "1", name: "read_file", content: "data" },
    { role: "assistant", content: "done" },
  ];
  const safe = sanitizeForProvider(messages);
  assert.deepEqual(safe, messages);
});

test("a compacted conversation is always well-formed after sanitization", () => {
  const big = "x".repeat(4000);
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "1", name: "read_file", content: big },
    { role: "assistant", content: "", toolCalls: [{ id: "2", name: "edit_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "2", name: "edit_file", content: "ok" },
    { role: "assistant", content: big },
    { role: "user", content: "continue" },
  ];
  compactIfNeeded(messages, { budgetTokens: 2500, compactAt: 0.8, todos: [] });
  assertWellFormed(sanitizeForProvider(messages));
});
