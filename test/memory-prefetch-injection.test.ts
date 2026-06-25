import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { renderRelevantMemory } from "../src/memory/prefetch.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";

class CapturingProvider implements ModelProvider {
  lastRequest: ChatRequest | null = null;
  async chat(input: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = input;
    return { text: "done", toolCalls: [] };
  }
}
async function ctxFor(root: string): Promise<ToolContext> {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}
function deps(provider: ModelProvider, ctx: ToolContext, over: Partial<AgentDeps> = {}): AgentDeps {
  return { provider, registry: defaultRegistry(), ctx, model: "fake", mode: "ask", maxTurns: 1, contextBudgetTokens: 64000, compactAt: 0.8, approve: async () => true, ...over };
}

test("renderRelevantMemory builds an advisory block; empty input → empty string", () => {
  assert.equal(renderRelevantMemory([]), "");
  const out = renderRelevantMemory([{ file: ".deepcoder/memory/auth.md", score: 5, reason: 'matched "auth"', text: "Use JWT." }]);
  assert.match(out, /\[relevant-memory\]/);
  assert.match(out, /not instructions/);
  assert.match(out, /Source: \.deepcoder\/memory\/auth\.md/);
  assert.match(out, /Use JWT\./);
});

test("prefetched memory reaches the model call but is NOT persisted to canonical history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-inject-"));
  const provider = new CapturingProvider();
  const history = [{ role: "user" as const, content: "how does auth work?" }];
  let sawPrompt = "";
  await runAgentLoop(history, deps(provider, await ctxFor(root), {
    relevantMemory: async (prompt) => {
      sawPrompt = prompt;
      return [renderRelevantMemory([{ file: ".deepcoder/memory/auth.md", score: 9, reason: "named", text: "SECRET-FREE NOTE" }])];
    },
  }));
  assert.equal(sawPrompt, "how does auth work?", "latest user prompt passed to the prefetcher");
  const sent = provider.lastRequest!.messages.map((m) => m.content).join("\n");
  assert.match(sent, /\[relevant-memory\]/, "injected into the model call");
  assert.ok(!history.some((m) => m.content.includes("relevant-memory")), "not persisted to canonical history");
});

test("no relevantMemory dep → no injection (default off)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-off-"));
  const provider = new CapturingProvider();
  await runAgentLoop([{ role: "user" as const, content: "hi" }], deps(provider, await ctxFor(root)));
  const sent = provider.lastRequest!.messages.map((m) => m.content).join("\n");
  assert.ok(!sent.includes("[relevant-memory]"));
});

test("[SECURITY] a throwing prefetcher never breaks the loop; a notice is emitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mem-throw-"));
  const provider = new CapturingProvider();
  const notices: string[] = [];
  const out = await runAgentLoop([{ role: "user" as const, content: "hi" }], deps(provider, await ctxFor(root), {
    onNotice: (m) => notices.push(m),
    relevantMemory: async () => { throw new Error("disk on fire"); },
  }));
  assert.equal(out, "done", "loop completed despite the prefetcher throwing");
  assert.ok(notices.some((n) => /memory prefetch error/.test(n)));
});
