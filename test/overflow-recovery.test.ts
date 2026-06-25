import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isContextOverflowError } from "../src/agent/retry.js";
import { recoverContextOverflow } from "../src/context/overflowRecovery.js";
import { isSummary } from "../src/context/compaction.js";
import { estimateMessages } from "../src/context/tokenBudget.js";
import { runAgentLoop, getResponseWithRetry, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { AgentMessage, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";

const OVERFLOW_MSG = "Error 400: This model's maximum context length is 65536 tokens, however you requested 80000";
const BIG = "x".repeat(4000);

class OverflowProvider implements ModelProvider {
  calls = 0;
  constructor(private failTimes: number, private msg = OVERFLOW_MSG) {}
  async chat(_input: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    if (this.calls <= this.failTimes) throw new Error(this.msg);
    return { text: "done", toolCalls: [] };
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
    { role: "user", content: "REFACTOR AUTH " + BIG },
    { role: "assistant", content: "working " + BIG },
    { role: "user", content: "more " + BIG },
    { role: "assistant", content: "Error: boom\n" + BIG },
    { role: "user", content: "keep going" },
  ];
}

// --- classifier -------------------------------------------------------------

test("isContextOverflowError detects representative provider errors, not generic 400s", () => {
  for (const m of [
    "prompt_too_long",
    "This model's maximum context length is 8192 tokens",
    "context_length_exceeded",
    "Please reduce the length of the messages",
    "the input tokens exceed the limit",
  ]) {
    assert.equal(isContextOverflowError(new Error(m)), true, m);
  }
  for (const m of ["400 Bad Request: invalid tool schema", "model not found", "429 rate limit", "unauthorized"]) {
    assert.equal(isContextOverflowError(new Error(m)), false, m);
  }
});

// --- retry behaviour --------------------------------------------------------

test("getResponseWithRetry throws overflow immediately (no transient retry)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-retry-"));
  const ctx = await ctxFor(root);
  const provider = new OverflowProvider(99);
  await assert.rejects(() => getResponseWithRetry(deps(provider, ctx), [{ role: "user", content: "hi" }]));
  assert.equal(provider.calls, 1, "overflow is not retried as a transient error");
});

// --- recovery strategy ------------------------------------------------------

test("recoverContextOverflow aggressively shrinks a large history and preserves protected content", () => {
  const msgs = bigHistory();
  const before = estimateMessages(msgs);
  const res = recoverContextOverflow(msgs, {
    budgetTokens: 4000, compactAt: 0.8, todos: [{ id: "1", content: "finish auth", status: "in_progress" }],
    readTracker: new Set(["src/auth.ts"]), writeTracker: new Set(["src/auth.ts"]),
  });
  assert.equal(res.recovered, true);
  assert.ok(res.after < before, "history shrank");
  const summary = msgs.find(isSummary)!;
  assert.match(summary.content, /REFACTOR AUTH/, "task preserved");
  assert.match(summary.content, /boom/, "last error preserved");
  assert.match(summary.content, /finish auth/, "pending todo preserved");
});

test("recoverContextOverflow returns recovered:false when nothing can shrink", () => {
  const msgs: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
  const res = recoverContextOverflow(msgs, { budgetTokens: 4000, compactAt: 0.8, todos: [], readTracker: new Set(), writeTracker: new Set() });
  assert.equal(res.recovered, false);
});

// --- loop integration -------------------------------------------------------

test("loop recovers from a one-shot overflow then continues; epoch reset fires", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-once-"));
  const provider = new OverflowProvider(1);
  let epochResets = 0;
  const notices: string[] = [];
  // Default 64k budget so proactive compaction does NOT fire at turn start —
  // the overflow recovery is then the sole context-epoch reset.
  const result = await runAgentLoop(bigHistory(), deps(provider, await ctxFor(root), {
    onContextEpochReset: () => { epochResets++; },
    onNotice: (m) => notices.push(m),
  }));
  assert.equal(result, "done", "loop completed after recovery");
  assert.equal(provider.calls, 2, "one failed call + one successful retry");
  assert.equal(epochResets, 1, "durable recovery reset the context epoch");
  assert.ok(notices.some((n) => /compacting aggressively/.test(n)));
  assert.ok(notices.some((n) => /Recovered from context overflow/.test(n)));
});

test("loop stops with a clear notice when overflow persists after recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ovf-twice-"));
  const ctx = await ctxFor(root);
  const provider = new OverflowProvider(99);
  const notices: string[] = [];
  await assert.rejects(() => runAgentLoop(bigHistory(), deps(provider, ctx, {
    contextBudgetTokens: 4000,
    onNotice: (m) => notices.push(m),
  })));
  assert.equal(provider.calls, 2, "initial + one bounded recovery retry, then stop");
  assert.ok(notices.some((n) => /Context overflow after recovery/.test(n)), "clear stop notice");
});
