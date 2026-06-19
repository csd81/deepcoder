import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../../src/agent/agentLoop.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { ApprovalMode } from "../../src/config/config.js";
import type { ChatResponse, ModelProvider, AgentMessage } from "../../src/providers/types.js";
import type { ToolContext } from "../../src/tools/types.js";

class FakeProvider implements ModelProvider {
  calls = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(): Promise<ChatResponse> {
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

function deps(
  root: string,
  provider: ModelProvider,
  mode: ApprovalMode,
  onPreToolUse?: AgentDeps["onPreToolUse"],
): AgentDeps {
  const ctx: ToolContext = { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
  return {
    provider,
    registry: defaultRegistry(),
    ctx,
    model: "fake",
    mode,
    maxTurns: 5,
    contextBudgetTokens: 100_000,
    compactAt: 0.8,
    mcpExecuteEnabled: false,
    approve: async () => true, // auto-approve any "ask" in this harness
    onPreToolUse,
  };
}

// write_file is mutate-kind: allowed in "auto", denied in "readonly" — a clean way
// to exercise the permission gate without the command classifier.
function writeCall(): ChatResponse {
  return { text: "", toolCalls: [{ id: "1", name: "write_file", arguments: { path: "created-by-tool.txt", content: "x" } }] };
}

test("a PreToolUse hook can DENY a tool: execute is skipped and the side effect never happens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hk-deny-"));
  try {
    const marker = path.join(root, "created-by-tool.txt");
    let consulted = 0;
    const onPreToolUse: AgentDeps["onPreToolUse"] = async () => {
      consulted++;
      return { decision: "deny", reason: "blocked by project hook" };
    };
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "write it" }];
    await runAgentLoop(messages, deps(root, new FakeProvider([writeCall()]), "auto", onPreToolUse));
    assert.equal(consulted, 1, "the hook must be consulted for an allowed tool");
    assert.equal(existsSync(marker), false, "a hook-denied tool must not execute");
    assert.ok(messages.some((m) => /block/i.test(m.content)), "the block should be reported back to the model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a PreToolUse hook returning none lets the tool run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hk-none-"));
  try {
    const marker = path.join(root, "created-by-tool.txt");
    const onPreToolUse: AgentDeps["onPreToolUse"] = async () => ({ decision: "none" });
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "write it" }];
    await runAgentLoop(messages, deps(root, new FakeProvider([writeCall()]), "auto", onPreToolUse));
    assert.equal(existsSync(marker), true, "a non-denied tool must execute normally");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tool denied by the permission policy never reaches the hook (allow cannot override deny)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hk-policy-"));
  try {
    const marker = path.join(root, "created-by-tool.txt");
    let consulted = 0;
    const onPreToolUse: AgentDeps["onPreToolUse"] = async () => {
      consulted++;
      return { decision: "none" };
    };
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "write it" }];
    // readonly mode → write_file (mutate) is denied by checkPermission, before any hook.
    await runAgentLoop(messages, deps(root, new FakeProvider([writeCall()]), "readonly", onPreToolUse));
    assert.equal(consulted, 0, "a policy-denied tool must NOT consult the hook");
    assert.equal(existsSync(marker), false, "and must not execute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
