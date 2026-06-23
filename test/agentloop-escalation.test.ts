import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { Tool, ToolContext } from "../src/tools/types.js";

/** Records the model id used on each chat() call; replays a scripted response list. */
class RecordingProvider implements ModelProvider {
  models: string[] = [];
  calls = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(input: ChatRequest): Promise<ChatResponse> {
    this.models.push(input.model);
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

/** A tool that always fails the SAME way. */
function flakyTool(name: string): Tool {
  return {
    name, description: name, kind: "read-only", rawSchema: { type: "object" },
    build: () => ({ kind: "read-only", describe: () => name, execute: async () => ({ output: "boom: it broke", isError: true }) }),
  };
}

async function ctxFor(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "esc-"));
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}

test("repeated identical tool error escalates the model (sticky) for later turns", async () => {
  const reg = new ToolRegistry();
  reg.register(flakyTool("flaky"));
  const provider = new RecordingProvider([
    { text: "", toolCalls: [{ id: "1", name: "flaky", arguments: {} }] }, // turn 0 → error (streak=1)
    { text: "", toolCalls: [{ id: "2", name: "flaky", arguments: {} }] }, // turn 1 → SAME error → escalate
    { text: "done", toolCalls: [] },                                        // turn 2 → should be on escalated model
  ]);
  let escalateCalls = 0;
  const deps: AgentDeps = {
    provider, registry: reg, ctx: await ctxFor(), model: "deepseek-v4-flash", mode: "auto",
    maxTurns: 10, contextBudgetTokens: 64000, compactAt: 0.8, approve: async () => true,
    onRepeatedToolError: () => { escalateCalls++; return "deepseek-v4-pro"; },
  };
  await runAgentLoop([{ role: "user", content: "do it" }], deps);

  assert.equal(escalateCalls, 1, "escalation fires once after the 2nd identical error");
  assert.deepEqual(provider.models, ["deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-pro"],
    "turns 0-1 on flash, turn 2 (after escalation) on pro");
});

test("no escalation hook → model never changes (behavior preserved)", async () => {
  const reg = new ToolRegistry();
  reg.register(flakyTool("flaky"));
  const provider = new RecordingProvider([
    { text: "", toolCalls: [{ id: "1", name: "flaky", arguments: {} }] },
    { text: "", toolCalls: [{ id: "2", name: "flaky", arguments: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const deps: AgentDeps = {
    provider, registry: reg, ctx: await ctxFor(), model: "deepseek-v4-flash", mode: "auto",
    maxTurns: 10, contextBudgetTokens: 64000, compactAt: 0.8, approve: async () => true,
  };
  await runAgentLoop([{ role: "user", content: "do it" }], deps);
  assert.ok(provider.models.every((m) => m === "deepseek-v4-flash"), "no hook → always flash");
});
