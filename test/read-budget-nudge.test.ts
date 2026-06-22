import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runAgentLoop,
  cumulativeToolBytes,
  READ_BUDGET_NUDGE_BYTES,
  type AgentDeps,
} from "../src/agent/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { Tool, ToolContext } from "../src/tools/types.js";

/** A provider that replays a scripted list of responses, one per turn. */
class FakeProvider implements ModelProvider {
  calls = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(_input: ChatRequest): Promise<ChatResponse> {
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

async function ctxFor(root: string): Promise<ToolContext> {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}

/** A read-only tool that returns a fixed-size payload, so we can control bytes. */
function bigReader(name: string, payload: string): Tool {
  return {
    name,
    description: name,
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => ({ kind: "read-only", describe: () => name, execute: async () => ({ output: payload }) }),
  };
}

function depsWith(provider: ModelProvider, ctx: ToolContext, reg: ToolRegistry, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    registry: reg,
    ctx,
    model: "fake",
    mode: "ask",
    maxTurns: 20,
    contextBudgetTokens: 10_000_000, // large, so compaction never fires in these tests
    compactAt: 0.99,
    approve: async () => true,
    ...over,
  };
}

const NUDGE_PHRASE = "Narrow your hypothesis";

test("cumulativeToolBytes sums only tool-role content", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "system text" },
    { role: "user", content: "user text" },
    { role: "assistant", content: "assistant text" },
    { role: "tool", content: "abcde", toolCallId: "1", name: "read_file" },
    { role: "tool", content: "fghij", toolCallId: "2", name: "read_file" },
  ];
  assert.equal(cumulativeToolBytes(messages), 10);
});

test("a read-budget nudge fires exactly once when tool output crosses the threshold", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-nudge-"));
  // Each tool call returns ~half the threshold, so two calls cross it, and a
  // third would cross again — but the nudge must still fire only once.
  const chunk = "x".repeat(Math.ceil(READ_BUDGET_NUDGE_BYTES * 0.6));
  const reg = new ToolRegistry();
  reg.register(bigReader("big_read", chunk));
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "big_read", arguments: {} }] },
    { text: "", toolCalls: [{ id: "2", name: "big_read", arguments: {} }] },
    { text: "", toolCalls: [{ id: "3", name: "big_read", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "explore" }];
  const notices: string[] = [];
  const final = await runAgentLoop(
    messages,
    depsWith(provider, await ctxFor(root), reg, { onNotice: (m) => notices.push(m) }),
  );
  assert.equal(final, "done");
  const nudges = messages.filter((m) => m.role === "system" && m.content.includes(NUDGE_PHRASE));
  assert.equal(nudges.length, 1, "the nudge must fire exactly once");
  // A user-facing notice should also be surfaced (matching the compaction notice mechanism).
  assert.equal(notices.filter((n) => /read budget|read-budget/i.test(n)).length, 1);
});

test("no nudge when tool output stays under the threshold", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-nonudge-"));
  const reg = new ToolRegistry();
  reg.register(bigReader("small_read", "tiny"));
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "small_read", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "explore" }];
  const notices: string[] = [];
  await runAgentLoop(
    messages,
    depsWith(provider, await ctxFor(root), reg, { onNotice: (m) => notices.push(m) }),
  );
  const nudges = messages.filter((m) => m.role === "system" && m.content.includes(NUDGE_PHRASE));
  assert.equal(nudges.length, 0, "no nudge under the threshold");
});
