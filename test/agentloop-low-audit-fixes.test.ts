import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { ToolContext, ToolResult } from "../src/tools/types.js";

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

function deps(provider: ModelProvider, ctx: ToolContext, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    registry: defaultRegistry(),
    ctx,
    model: "fake",
    mode: "ask",
    maxTurns: 10,
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

// ── Fix 1: onPreToolUse throwing must not abort the run ───────────────────────

test("a throwing onPreToolUse does not abort the loop; the tool still runs and a notice is emitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-prehook-throw-"));
  await writeFile(path.join(root, "a.txt"), "contents here", "utf8");
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.txt" } }] },
    { text: "recovered", toolCalls: [] },
  ]);
  const notices: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "read a.txt" }];
  const final = await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onPreToolUse: async () => {
        throw new Error("hook boom");
      },
      onNotice: (m) => notices.push(m),
    }),
  );
  // The loop completed normally rather than crashing on the thrown hook.
  assert.equal(final, "recovered");
  // The tool still ran (proceed on hook error) — its result is in history.
  assert.ok(
    messages.some((m) => m.role === "tool" && /contents here/.test(m.content)),
    "the tool still executed despite the throwing pre-hook",
  );
  // A notice surfaced the hook failure.
  assert.ok(
    notices.some((n) => /hook boom|hook/i.test(n)),
    "a notice surfaced the PreToolUse hook error",
  );
});

// ── Fix 2: synthetic results fire onToolCall/onToolResult ─────────────────────

test("an unknown-tool call fires onToolResult (not onToolCall) so the renderer shows a block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-unknown-tool-"));
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "no_such_tool", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const results: { name: string; result: ToolResult }[] = [];
  const calls: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "use a tool" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, result) => results.push({ name, result }),
    }),
  );
  assert.ok(!calls.includes("no_such_tool"), "onToolCall must NOT fire for a synthetic result (keeps trace.toolsCalled a clean record of real dispatches)");
  const entry = results.find((r) => r.name === "no_such_tool");
  assert.ok(entry, "onToolResult received an entry for the unknown-tool call");
  assert.ok(/Unknown tool/.test(entry!.result.output), "the synthetic result describes the unknown tool");
  assert.equal(entry!.result.isError, true);
});

test("invalid-args fires onToolResult so the renderer shows a block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-invalid-args-"));
  // read_file with a missing required `path` → InvalidArgumentsError in build().
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const results: { name: string; result: ToolResult }[] = [];
  const calls: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "read nothing" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, result) => results.push({ name, result }),
    }),
  );
  assert.ok(!calls.includes("read_file"), "onToolCall must NOT fire for an invalid-args synthetic result");
  const entry = results.find((r) => r.name === "read_file");
  assert.ok(entry, "onToolResult received an entry for the invalid-args call");
  assert.ok(/invalid arguments/i.test(entry!.result.output));
  assert.equal(entry!.result.isError, true);
});

test("ask-rejected fires onToolResult so the renderer shows a block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-ask-reject-"));
  await writeFile(path.join(root, "a.txt"), "x", "utf8");
  // write_file is an `ask` tool under mode "ask"; reject it.
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "write_file", arguments: { path: "a.txt", content: "new" } }] },
    { text: "done", toolCalls: [] },
  ]);
  const results: { name: string; result: ToolResult }[] = [];
  const calls: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "write it" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      approve: async () => false,
      onToolCall: (name) => calls.push(name),
      onToolResult: (name, result) => results.push({ name, result }),
    }),
  );
  assert.ok(!calls.includes("write_file"), "onToolCall must NOT fire for an ask-rejected synthetic result");
  const entry = results.find((r) => r.name === "write_file");
  assert.ok(entry, "onToolResult received an entry for the ask-rejected call");
  assert.ok(/rejected/i.test(entry!.result.output));
});
