import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelEvent, ModelProvider } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";

class StreamingProvider implements ModelProvider {
  constructor(private scripts: ModelEvent[][]) {}
  calls = 0;
  async chat(): Promise<ChatResponse> {
    throw new Error("chat() should not be called when streamChat exists");
  }
  async *streamChat(_input: ChatRequest): AsyncIterable<ModelEvent> {
    const events = this.scripts[this.calls++] ?? [{ type: "done" } as ModelEvent];
    for (const e of events) yield e;
  }
}

async function ctxFor(root: string): Promise<ToolContext> {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}

function deps(provider: ModelProvider, ctx: ToolContext, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider, registry: defaultRegistry(), ctx, model: "fake", mode: "ask", maxTurns: 10,
    approve: async () => true, ...over,
  };
}

test("loop consumes streamChat, fires text deltas, and assembles tool calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-stream-"));
  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  const provider = new StreamingProvider([
    [
      { type: "assistant_text_delta", text: "Let me " },
      { type: "assistant_text_delta", text: "look." },
      { type: "tool_call_complete", toolCall: { id: "1", name: "read_file", arguments: { path: "a.txt" } } },
      { type: "done" },
    ],
    [
      { type: "assistant_text_delta", text: "All done." },
      { type: "done" },
    ],
  ]);
  const deltas: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "read it" }];
  const final = await runAgentLoop(messages, deps(provider, await ctxFor(root), { onAssistantTextDelta: (c) => deltas.push(c) }));
  assert.equal(deltas.join(""), "Let me look.All done.");
  assert.equal(final, "All done.");
  assert.ok(messages.some((m) => m.role === "tool" && /hello/.test(m.content)));
});

test("loop falls back to chat() when streamChat is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fallback-"));
  let chatCalled = false;
  const provider: ModelProvider = {
    async chat(): Promise<ChatResponse> {
      chatCalled = true;
      return { text: "hi", toolCalls: [] };
    },
  };
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  const final = await runAgentLoop(messages, deps(provider, await ctxFor(root)));
  assert.equal(chatCalled, true);
  assert.equal(final, "hi");
});
