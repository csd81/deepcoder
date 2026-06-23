import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry, ToolRegistry } from "../src/tools/registry.js";
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

test("delegationHint blocks are injected as ephemeral system context, once, without mutating history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-deleghint-"));
  // Capture the messages the provider sees on each turn.
  const seen: AgentMessage[][] = [];
  const provider: ModelProvider = {
    async chat(input: ChatRequest): Promise<ChatResponse> {
      seen.push(input.messages);
      // turn 0: one no-op tool call so there's a 2nd turn; turn 1: finish.
      return seen.length === 1
        ? { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.txt" } }] }
        : { text: "done", toolCalls: [] };
    },
  } as ModelProvider;
  await writeFile(path.join(root, "a.txt"), "hi", "utf8");
  const messages: AgentMessage[] = [{ role: "user", content: "audit everything" }];
  let calls = 0;
  const delegationHint = () => (calls++ === 0 ? ["[delegation assessment] try delegate"] : []);
  await runAgentLoop(messages, deps(provider, await ctxFor(root), { delegationHint }));

  const hintTurns = seen.filter((ms) => ms.some((m) => m.role === "system" && /delegation assessment/.test(m.content)));
  assert.equal(hintTurns.length, 1, "hint appears in exactly one turn's prompt");
  assert.ok(!messages.some((m) => m.role === "system" && /delegation assessment/.test(m.content)), "never persisted to history");
});

test("no delegationHint → no extra system context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-nohint-"));
  let captured: AgentMessage[] = [];
  const provider: ModelProvider = {
    async chat(input: ChatRequest): Promise<ChatResponse> {
      captured = input.messages;
      return { text: "done", toolCalls: [] };
    },
  } as ModelProvider;
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(messages, deps(provider, await ctxFor(root)));
  assert.ok(!captured.some((m) => m.role === "system" && /delegation assessment/.test(m.content)));
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

test("aborting during one tool stops the remaining tool calls in the same turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-abort-"));
  const controller = new AbortController();
  let secondRan = false;
  const fakeTool = (name: string, exec: () => void): Tool => ({
    name,
    description: name,
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => ({ kind: "read-only", describe: () => name, execute: async () => { exec(); return { output: "ok" }; } }),
  });
  const reg = new ToolRegistry();
  reg.register(fakeTool("abort_now", () => controller.abort()));
  reg.register(fakeTool("after", () => { secondRan = true; }));

  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "abort_now", arguments: {} }, { id: "2", name: "after", arguments: {} }] },
    { text: "should not get here", toolCalls: [] },
  ]);
  const ctx: ToolContext = { workspaceRoot: root, signal: controller.signal, readTracker: new Set(), todos: [] };
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  await runAgentLoop(messages, {
    provider, registry: reg, ctx, model: "fake", mode: "ask", maxTurns: 10,
    contextBudgetTokens: 64000, compactAt: 0.8, approve: async () => true,
  });
  assert.equal(secondRan, false, "the second tool must not run after an abort");
});

test("a tool whose preview throws still runs after approval (preview is best-effort)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-preview-"));
  let executed = false;
  const flakyPreview: Tool = {
    name: "flaky",
    description: "flaky",
    kind: "mutate", // forces an `ask` in ask mode → preview is consulted
    rawSchema: { type: "object" },
    build: () => ({
      kind: "mutate",
      describe: () => "flaky",
      preview: async () => { throw new Error("preview blew up"); },
      execute: async () => { executed = true; return { output: "ran" }; },
    }),
  };
  const reg = new ToolRegistry();
  reg.register(flakyPreview);
  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "1", name: "flaky", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  let sawPreview: unknown = "unset";
  const final = await runAgentLoop(messages, deps(provider, await ctxFor(root), {
    registry: reg,
    approve: async (_inv, preview) => { sawPreview = preview; return true; },
  }));
  assert.equal(final, "done");
  assert.equal(executed, true, "a thrown preview must not block execution");
  assert.equal(sawPreview, undefined, "approve receives undefined when preview throws");
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
