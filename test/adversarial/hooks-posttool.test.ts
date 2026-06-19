import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../../src/agent/agentLoop.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { ChatResponse, ModelProvider, AgentMessage } from "../../src/providers/types.js";
import type { ToolContext, ToolResult, ToolInvocation } from "../../src/tools/types.js";

class FakeProvider implements ModelProvider {
  calls = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(): Promise<ChatResponse> {
    return this.script[this.calls++] ?? { text: "done", toolCalls: [] };
  }
}

function baseDeps(root: string, provider: ModelProvider): AgentDeps {
  const ctx: ToolContext = { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
  return {
    provider,
    registry: defaultRegistry(),
    ctx,
    model: "fake",
    mode: "auto",
    maxTurns: 5,
    contextBudgetTokens: 100_000,
    compactAt: 0.8,
    mcpExecuteEnabled: false,
    approve: async () => true,
  };
}

const writeCall = (): ChatResponse => ({
  text: "",
  toolCalls: [{ id: "1", name: "write_file", arguments: { path: "out.txt", content: "x" } }],
});
const readMissing = (): ChatResponse => ({
  text: "",
  toolCalls: [{ id: "1", name: "read_file", arguments: { path: "does-not-exist.txt" } }],
});

test("onPostTool fires with failed=false after a successful tool and its warnings reach onNotice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pt-ok-"));
  try {
    const seen: { failed: boolean; name: string }[] = [];
    const notices: string[] = [];
    const deps = baseDeps(root, new FakeProvider([writeCall()]));
    deps.onNotice = (m) => notices.push(m);
    deps.onPostTool = async (failed: boolean, toolName: string, _inv: ToolInvocation, _r: ToolResult) => {
      seen.push({ failed, name: toolName });
      return ["formatted out.txt"];
    };
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "write it" }];
    await runAgentLoop(messages, deps);
    assert.deepEqual(seen, [{ failed: false, name: "write_file" }]);
    assert.ok(notices.some((n) => /formatted out.txt/.test(n)), "post-tool warning surfaced via onNotice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onPostTool fires with failed=true when the tool result is an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pt-err-"));
  try {
    let failedSeen: boolean | null = null;
    const deps = baseDeps(root, new FakeProvider([readMissing()]));
    deps.onPostTool = async (failed: boolean) => {
      failedSeen = failed;
      return undefined;
    };
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "read it" }];
    await runAgentLoop(messages, deps);
    assert.equal(failedSeen, true, "a tool that errored must fire PostToolFailure (failed=true)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing onPostTool never breaks the agent loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pt-throw-"));
  try {
    const deps = baseDeps(root, new FakeProvider([writeCall()]));
    deps.onPostTool = async () => {
      throw new Error("hook blew up");
    };
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "write it" }];
    await assert.doesNotReject(runAgentLoop(messages, deps));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
