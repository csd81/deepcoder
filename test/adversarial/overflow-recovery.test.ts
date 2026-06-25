import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoverContextOverflow } from "../../src/context/overflowRecovery.js";
import { runAgentLoop, sanitizeForProvider, type AgentDeps } from "../../src/agent/agentLoop.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../../src/providers/types.js";
import type { ToolContext } from "../../src/tools/types.js";

const OVERFLOW_MSG = "Error 400: maximum context length is 65536 tokens";
const BIG = "x".repeat(4000);

class AlwaysOverflow implements ModelProvider {
  calls = 0;
  async chat(_i: ChatRequest): Promise<ChatResponse> { this.calls++; throw new Error(OVERFLOW_MSG); }
}
/** Succeeds, but its assistant text *contains* overflow-shaped phrases. */
class ChattyProvider implements ModelProvider {
  calls = 0;
  async chat(_i: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return { text: "Note: a prompt_too_long / context_length_exceeded error could happen.", toolCalls: [] };
  }
}

async function ctxFor(root: string): Promise<ToolContext> {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}
function deps(provider: ModelProvider, ctx: ToolContext, over: Partial<AgentDeps> = {}): AgentDeps {
  return { provider, registry: defaultRegistry(), ctx, model: "fake", mode: "ask", maxTurns: 1, contextBudgetTokens: 64000, compactAt: 0.8, approve: async () => true, ...over };
}
function bigHistory(): AgentMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "task " + BIG },
    { role: "assistant", content: "work " + BIG },
    { role: "user", content: "more " + BIG },
    { role: "user", content: "go" },
  ];
}

test("[SECURITY] overflow-shaped text in a SUCCESSFUL response does not trigger recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-adv-text-"));
  const provider = new ChattyProvider();
  const notices: string[] = [];
  const out = await runAgentLoop(
    [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    deps(provider, await ctxFor(root), { onNotice: (m) => notices.push(m) }),
  );
  assert.match(out, /prompt_too_long/, "the response text is returned verbatim");
  assert.equal(provider.calls, 1, "no recovery retry — recovery keys on thrown errors, not content");
  assert.ok(!notices.some((n) => /compacting aggressively/.test(n)), "no recovery fired");
});

test("[SECURITY] repeated overflow is bounded — it cannot loop forever", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-adv-bound-"));
  const ctx = await ctxFor(root);
  const provider = new AlwaysOverflow();
  await assert.rejects(() => runAgentLoop(bigHistory(), deps(provider, ctx, { overflowRecoveryMaxAttempts: 2 })));
  assert.ok(provider.calls >= 2 && provider.calls <= 3, `bounded recovery attempts (got ${provider.calls})`);
});

test("[SECURITY] feature flag off surfaces the original provider error with no recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-adv-off-"));
  const ctx = await ctxFor(root);
  const provider = new AlwaysOverflow();
  const notices: string[] = [];
  await assert.rejects(() => runAgentLoop(bigHistory(), deps(provider, ctx, { reactiveOverflowRecovery: false, onNotice: (m) => notices.push(m) })));
  assert.equal(provider.calls, 1, "no recovery when disabled");
  assert.ok(!notices.some((n) => /compacting aggressively/.test(n)));
});

test("[SECURITY] provider-safe tool-call pairing remains valid after recovery", () => {
  // A tool-call pair in the recent tail must survive an aggressive recovery
  // compaction without becoming an orphan.
  const msgs: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task " + BIG },
    { role: "assistant", content: "old " + BIG },
    { role: "user", content: "mid " + BIG },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "t1", content: "recent result" },
    { role: "user", content: "go" },
  ];
  recoverContextOverflow(msgs, { budgetTokens: 4000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set() });
  assert.deepEqual(sanitizeForProvider(msgs), msgs, "no orphaned tool calls/results after recovery");
});
