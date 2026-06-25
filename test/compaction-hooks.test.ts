import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";
import type { AdvisoryOutcome } from "../src/hooks/types.js";

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
  return {
    provider,
    registry: defaultRegistry(),
    ctx,
    model: "fake",
    mode: "ask",
    maxTurns: 1,
    // Tiny budget so the initial history is over the trigger and PreCompact fires.
    contextBudgetTokens: 100,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

/** Over-budget history (≫ 80-token trigger) so the lifecycle hooks fire. */
function bigHistory(): AgentMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "x".repeat(4000) },
    { role: "assistant", content: "y".repeat(4000) },
    { role: "user", content: "go" },
  ];
}

test("PreCompact and PostCompact fire on automatic compaction with real token stats", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compact-hooks-"));
  const pre: unknown[] = [];
  const post: unknown[] = [];
  await runAgentLoop(bigHistory(), deps(new CapturingProvider(), await ctxFor(root), {
    onPreCompact: async (input) => { pre.push(input); return { warnings: [], context: [] }; },
    onPostCompact: async (input) => { post.push(input); return { warnings: [], context: [] }; },
  }));
  assert.equal(pre.length, 1, "PreCompact fired once");
  assert.equal(post.length, 1, "PostCompact fired once");
  const p = pre[0] as { beforeTokens: number; triggerTokens: number; stage: string; force: boolean };
  assert.ok(p.beforeTokens > p.triggerTokens, "fired because over trigger");
  assert.equal(p.stage, "auto");
  assert.equal(p.force, false);
  const q = post[0] as { beforeTokens: number; afterTokens: number; stages: unknown[] };
  assert.ok(Array.isArray(q.stages) && q.stages.length > 0, "PostCompact carries stage stats");
});

test("hooks do NOT fire when history is under the trigger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compact-hooks-under-"));
  let fired = 0;
  await runAgentLoop(
    [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    deps(new CapturingProvider(), await ctxFor(root), {
      contextBudgetTokens: 1_000_000, // way under
      onPreCompact: async () => { fired++; return { warnings: [], context: [] }; },
      onPostCompact: async () => { fired++; return { warnings: [], context: [] }; },
    }),
  );
  assert.equal(fired, 0, "no compaction → no lifecycle hooks");
});

test("PostCompact injected context reaches the model call but is not persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compact-hooks-inject-"));
  const provider = new CapturingProvider();
  const history = bigHistory();
  await runAgentLoop(history, deps(provider, await ctxFor(root), {
    onPostCompact: async (): Promise<AdvisoryOutcome> => ({ warnings: [], context: ["GUIDANCE: re-read the spec"] }),
  }));
  const sentToModel = provider.lastRequest!.messages.map((m) => m.content).join("\n");
  assert.match(sentToModel, /GUIDANCE: re-read the spec/, "injected into the model call");
  // Ephemeral: the canonical history array the loop persists never gains the note.
  assert.ok(!history.some((m) => m.content.includes("GUIDANCE: re-read the spec")), "not persisted to canonical history");
});

test("hook warnings are surfaced via onNotice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compact-hooks-warn-"));
  const notices: string[] = [];
  await runAgentLoop(bigHistory(), deps(new CapturingProvider(), await ctxFor(root), {
    onNotice: (m) => notices.push(m),
    onPreCompact: async () => ({ warnings: ["budget is tight"], context: [] }),
    onPostCompact: async () => ({ warnings: ["consider a deep compact"], context: [] }),
  }));
  assert.ok(notices.some((n) => /PreCompact hook: budget is tight/.test(n)));
  assert.ok(notices.some((n) => /PostCompact hook: consider a deep compact/.test(n)));
});

test("[SECURITY] a throwing/blocking hook cannot break or block compaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compact-hooks-throw-"));
  const provider = new CapturingProvider();
  const notices: string[] = [];
  // PreCompact throws (and a hostile hook cannot "deny" compaction — advisory only).
  const result = await runAgentLoop(bigHistory(), deps(provider, await ctxFor(root), {
    onNotice: (m) => notices.push(m),
    onPreCompact: async () => { throw new Error("hook exploded"); },
    onPostCompact: async () => { throw new Error("post exploded"); },
  }));
  assert.equal(result, "done", "the loop completed despite throwing hooks");
  assert.ok(provider.lastRequest, "the model call still happened (compaction not blocked)");
  assert.ok(notices.some((n) => /hook PreCompact error/.test(n)), "failure surfaced, not fatal");
  assert.ok(notices.some((n) => /hook PostCompact error/.test(n)));
});
