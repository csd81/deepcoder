import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
// [TUR-1] this import is the red anchor on baseline: the module does not exist yet.
import { formatTokenUsageReminder } from "../src/agent/tokenUsageReminder.js";
import { ToolRegistry } from "../src/tools/registry.js";
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

function depsWith(
  provider: ModelProvider,
  ctx: ToolContext,
  reg: ToolRegistry,
  over: Partial<AgentDeps> = {},
): AgentDeps {
  return {
    provider,
    registry: reg,
    ctx,
    model: "fake",
    mode: "ask",
    maxTurns: 20,
    // Small budget so a provider-reported promptTokens can cross compactAt×budget.
    // compaction keys on ESTIMATED tokens of the (tiny) messages array, so it
    // never fires here — only the token-usage reminder can.
    contextBudgetTokens: 1000,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

const PREFIX = "Token usage:";

// [TUR-1] pure formatter: "Token usage: {used}/{total}; {remaining} remaining",
// with remaining clamped at 0.
test("[TUR-1] formatTokenUsageReminder renders used/total/remaining", () => {
  assert.equal(formatTokenUsageReminder(800, 1000), "Token usage: 800/1000; 200 remaining");
  assert.equal(formatTokenUsageReminder(1200, 1000), "Token usage: 1200/1000; 0 remaining");
});

// [TUR-2] WIRED: the agent loop must inject a `system` reminder when the
// provider-reported promptTokens crosses compactAt × contextBudgetTokens.
// Green here ⇒ the feature is actually wired into runAgentLoop, not inert.
test("[TUR-2] the agent loop injects a token-usage system reminder when context fills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-tur-"));
  const reg = new ToolRegistry();
  const provider = new FakeProvider([
    { text: "done", toolCalls: [], usage: { promptTokens: 900, completionTokens: 10, totalTokens: 910 } },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(messages, depsWith(provider, await ctxFor(root), reg));
  const reminders = messages.filter((m) => m.role === "system" && m.content.startsWith(PREFIX));
  assert.equal(reminders.length, 1, "exactly one token-usage reminder once context crosses the threshold");
  assert.match(reminders[0].content, /900\/1000; 100 remaining/);
});

// [TUR-3] threshold gate: no reminder while context stays well under compactAt×budget.
test("[TUR-3] no token-usage reminder when context is well under the threshold", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-tur-under-"));
  const reg = new ToolRegistry();
  const provider = new FakeProvider([
    { text: "done", toolCalls: [], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(messages, depsWith(provider, await ctxFor(root), reg));
  const reminders = messages.filter((m) => m.role === "system" && m.content.startsWith(PREFIX));
  assert.equal(reminders.length, 0);
});

// [TUR-4] one-shot: the reminder fires at most once per run even if multiple
// turns stay over the threshold (mirrors the read-budget nudge).
test("[TUR-4] the token-usage reminder fires at most once per run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-tur-once-"));
  const reg = new ToolRegistry();
  const over = { promptTokens: 950, completionTokens: 10, totalTokens: 960 };
  const provider = new FakeProvider([
    { text: "t1", toolCalls: [{ id: "1", name: "noop", arguments: {} }], usage: over },
    { text: "done", toolCalls: [], usage: over },
  ]);
  reg.register({
    name: "noop",
    description: "noop",
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => ({ kind: "read-only", describe: () => "noop", execute: async () => ({ output: "ok" }) }),
  });
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(messages, depsWith(provider, await ctxFor(root), reg));
  const reminders = messages.filter((m) => m.role === "system" && m.content.startsWith(PREFIX));
  assert.equal(reminders.length, 1, "one-shot: at most one reminder per run");
});
