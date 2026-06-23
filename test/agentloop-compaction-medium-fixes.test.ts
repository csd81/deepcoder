import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, MAX_TOOL_RESULT_BYTES, type AgentDeps } from "../src/agent/agentLoop.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
} from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { buildStructuredSummary, compactIfNeeded } from "../src/context/compaction.js";

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

// Fix 1: final assistant text must reach onAssistantText when no deltas streamed,
// even when onAssistantTextDelta is wired.
test("non-delta response delivers final text exactly once via onAssistantText (delta cb wired)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fix1b-"));
  // A capturing provider with NO streamChat → forces the non-streaming chat()
  // path while onAssistantTextDelta is still wired. Final text must be delivered.
  const provider: ModelProvider = {
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return { text: "FINAL ANSWER", toolCalls: [] };
    },
  } as ModelProvider;

  const delivered: string[] = [];
  const deltas: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "answer me" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onAssistantTextDelta: (c) => deltas.push(c),
      onAssistantText: (t) => delivered.push(t),
    }),
  );

  assert.deepEqual(deltas, [], "no deltas were streamed");
  assert.deepEqual(delivered, ["FINAL ANSWER"], "final text delivered exactly once");
});

test("when deltas DID stream, onAssistantText is NOT called again (no duplicate)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fix1c-"));
  const provider: ModelProvider = {
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return { text: "FINAL", toolCalls: [] };
    },
    async *streamChat(_req: ChatRequest): AsyncIterable<ModelEvent> {
      yield { type: "assistant_text_delta", text: "FIN" };
      yield { type: "assistant_text_delta", text: "AL" };
      yield { type: "done" };
    },
  } as ModelProvider;

  const delivered: string[] = [];
  const deltas: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onAssistantTextDelta: (c) => deltas.push(c),
      onAssistantText: (t) => delivered.push(t),
    }),
  );

  assert.deepEqual(deltas, ["FIN", "AL"], "deltas streamed");
  assert.deepEqual(delivered, [], "onAssistantText not called — deltas already rendered");
});

test("stream-fallback (early no-content error) still delivers final text via onAssistantText", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fix1d-"));
  // streamChat errors before any content → loop falls back to chat(). Since no
  // delta fired, the final non-streamed text must reach onAssistantText.
  const provider: ModelProvider = {
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return { text: "FALLBACK ANSWER", toolCalls: [] };
    },
    async *streamChat(_req: ChatRequest): AsyncIterable<ModelEvent> {
      yield { type: "error", message: "boom" };
    },
  } as ModelProvider;

  const delivered: string[] = [];
  const deltas: string[] = [];
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
  await runAgentLoop(
    messages,
    deps(provider, await ctxFor(root), {
      onAssistantTextDelta: (c) => deltas.push(c),
      onAssistantText: (t) => delivered.push(t),
    }),
  );

  assert.deepEqual(deltas, [], "no deltas streamed (error before content)");
  assert.deepEqual(delivered, ["FALLBACK ANSWER"], "fallback final text delivered exactly once");
});

// Fix 2: oversized tool result is capped with a truncation marker before storage.
test("an oversized tool result is truncated with a clear marker before storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fix2-"));
  const huge = "x".repeat(MAX_TOOL_RESULT_BYTES + 50_000);
  await writeFile(path.join(root, "big.txt"), huge, "utf8");

  const provider: ModelProvider = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // first turn reads the big file; second turn finishes.
      const already = req.messages.some((m) => m.role === "tool");
      return already
        ? { text: "done", toolCalls: [] }
        : { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "big.txt" } }] };
    },
  } as ModelProvider;

  const messages: AgentMessage[] = [{ role: "user", content: "read big.txt" }];
  await runAgentLoop(messages, deps(provider, await ctxFor(root)));

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "a tool result was stored");
  assert.ok(
    toolMsg!.content.length <= MAX_TOOL_RESULT_BYTES + 500,
    `stored result capped (got ${toolMsg!.content.length} bytes)`,
  );
  assert.match(toolMsg!.content, /truncated/i, "truncation marker present");
});

test("a small tool result is stored verbatim (no truncation)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-fix2b-"));
  await writeFile(path.join(root, "small.txt"), "hello world", "utf8");
  const provider: ModelProvider = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const already = req.messages.some((m) => m.role === "tool");
      return already
        ? { text: "done", toolCalls: [] }
        : { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "small.txt" } }] };
    },
  } as ModelProvider;
  const messages: AgentMessage[] = [{ role: "user", content: "read small.txt" }];
  await runAgentLoop(messages, deps(provider, await ctxFor(root)));
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && /hello world/.test(toolMsg.content));
  assert.doesNotMatch(toolMsg!.content, /truncated/i);
});

// Fix 3: re-compaction preserves the original task across two compactions.
test("buildStructuredSummary recovers the real task from a prior summary (re-compaction)", () => {
  const originalTask = "Implement the OAuth token refresh flow with retry";
  const first = buildStructuredSummary(
    [{ role: "user", content: originalTask }],
    new Set(),
    new Set(),
    [],
  );
  assert.match(first, /## Task/);
  assert.ok(first.includes(originalTask), "first summary carries the task");

  // Second compaction: the first user message IS the prior summary.
  const second = buildStructuredSummary(
    [{ role: "user", content: first }],
    new Set(),
    new Set(),
    [],
  );
  // The task section must still be the original task, NOT the summary tag.
  assert.ok(second.includes(originalTask), "second summary preserves the original task");
  assert.ok(
    !/## Task\s*\n\[compacted-summary\]/.test(second),
    "task is not the summary tag",
  );
});

test("two successive compactIfNeeded passes preserve the original task text", () => {
  const originalTask = "Build a rate limiter using a token bucket algorithm";
  const filler = (n: number): AgentMessage => ({
    role: n % 2 === 0 ? "assistant" : "user",
    content: "filler ".repeat(400) + n,
  });

  const build = (): AgentMessage[] => {
    const ms: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: originalTask }];
    for (let i = 0; i < 40; i++) ms.push(filler(i));
    return ms;
  };

  const opts = {
    budgetTokens: 4000,
    compactAt: 0.5,
    todos: [],
    readTracker: new Set<string>(),
    writeTracker: new Set<string>(),
    force: true,
  };

  const messages = build();
  const r1 = compactIfNeeded(messages, opts);
  assert.ok(r1.compacted, "first compaction happened");
  const summary1 = messages.find((m) => m.role === "user" && m.content.startsWith("[compacted-summary]"));
  assert.ok(summary1 && summary1.content.includes(originalTask), "task survived first compaction");

  // Grow again and compact a second time.
  for (let i = 40; i < 80; i++) messages.push(filler(i));
  const r2 = compactIfNeeded(messages, opts);
  assert.ok(r2.compacted, "second compaction happened");
  const summary2 = messages.find((m) => m.role === "user" && m.content.startsWith("[compacted-summary]"));
  assert.ok(summary2, "a summary exists after second compaction");
  assert.ok(summary2!.content.includes(originalTask), "task survived second compaction");
});
