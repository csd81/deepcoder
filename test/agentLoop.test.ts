import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";

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

test("loop runs a read_file tool call then returns final text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-loop-"));
  await writeFile(path.join(root, "a.txt"), "contents here", "utf8");
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.txt" } }] },
    { text: "The file says: contents here", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "read a.txt" }];
  const final = await runAgentLoop(messages, deps(provider, await ctxFor(root)));
  assert.equal(final, "The file says: contents here");
  // tool result must have been appended for the model to see.
  assert.ok(messages.some((m) => m.role === "tool" && /contents here/.test(m.content)));
});

test("denied run_bash returns a tool error and never executes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-deny-"));
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "run_bash", arguments: { command: "rm -rf /" } }] },
    { text: "ok", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "delete everything" }];
  let approveCalled = false;
  await runAgentLoop(messages, deps(provider, await ctxFor(root), { approve: async () => { approveCalled = true; return true; } }));
  assert.equal(approveCalled, false, "approval should not be asked for a denied command");
  assert.ok(messages.some((m) => m.role === "tool" && /Denied by permission policy/.test(m.content)));
});

test("a tool that throws becomes a recoverable tool-result, not a fatal error", async () => {
  // read_file on a missing path throws ENOENT; the loop must keep going and the
  // model must see the failure as a tool result it can react to.
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-toolthrow-"));
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "does-not-exist.txt" } }] },
    { text: "recovered", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "read it" }];
  const final = await runAgentLoop(messages, deps(provider, await ctxFor(root)));
  assert.equal(final, "recovered");
  assert.ok(
    messages.some((m) => m.role === "tool" && /failed|ENOENT|no such file/i.test(m.content)),
    "the throw surfaced as a tool-result",
  );
});

test("max turns stops a runaway tool-call loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-runaway-"));
  await writeFile(path.join(root, "a.txt"), "x", "utf8");
  // Always asks to read the file, never finishes.
  const provider = new FakeProvider(
    Array.from({ length: 50 }, (_, i) => ({
      text: "",
      toolCalls: [{ id: String(i), name: "read_file", arguments: { path: "a.txt" } }],
    })),
  );
  const messages: AgentMessage[] = [{ role: "user", content: "loop forever" }];
  let notice = "";
  const final = await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), { maxTurns: 3, onNotice: (m) => (notice = m) }),
  );
  assert.equal(final, "");
  assert.match(notice, /max turns/);
  assert.equal(provider.calls, 3);
});
