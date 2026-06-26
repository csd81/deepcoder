import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../src/agent/agentLoop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
} from "../src/providers/types.js";
import type { Tool, ToolContext } from "../src/tools/types.js";

// ── harness ───────────────────────────────────────────────────────────────────

/** Emits scripted ModelEvent sequences, one per turn. */
class StreamingScriptedProvider implements ModelProvider {
  calls = 0;
  constructor(private scripts: ModelEvent[][]) {}
  async chat(): Promise<ChatResponse> {
    throw new Error("chat() should not be called when streamChat exists");
  }
  async *streamChat(_input: ChatRequest): AsyncIterable<ModelEvent> {
    const events = this.scripts[this.calls++] ?? [{ type: "done" } as ModelEvent];
    for (const e of events) yield e;
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Poll until `cond()` is true or `ms` elapses (then fail). */
async function waitUntil(cond: () => boolean, ms = 1000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

interface Log {
  events: string[];
  active: number;
  maxActive: number;
  executed: string[];
}
function newLog(): Log {
  return { events: [], active: 0, maxActive: 0, executed: [] };
}

/** A read-only tool that records start/end and waits on a gate before resolving. */
function readTool(name: string, log: Log, gate: Promise<void>): Tool {
  return {
    name,
    description: name,
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => ({
      kind: "read-only",
      describe: () => name,
      execute: async () => {
        log.executed.push(name);
        log.events.push(`start:${name}`);
        log.active += 1;
        log.maxActive = Math.max(log.maxActive, log.active);
        await gate;
        log.active -= 1;
        log.events.push(`end:${name}`);
        return { output: `out:${name}` };
      },
    }),
  };
}

/** A mutate (exclusive-lane) tool that asserts no read is in flight when it runs. */
function writeTool(name: string, log: Log): Tool {
  return {
    name,
    description: name,
    kind: "mutate",
    rawSchema: { type: "object" },
    build: () => ({
      kind: "mutate",
      describe: () => name,
      affectedPaths: [],
      execute: async () => {
        log.executed.push(name);
        log.events.push(`start:${name}`);
        // Drain-before-exclusive: no read may be in flight here.
        assert.equal(log.active, 0, `${name} ran while a read was still in flight`);
        log.events.push(`end:${name}`);
        return { output: `out:${name}` };
      },
    }),
  };
}

async function ctxFor(over: Partial<ToolContext> = {}): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "stream-int-"));
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [], ...over };
}

function deps(
  provider: ModelProvider,
  registry: ToolRegistry,
  ctx: ToolContext,
  over: Partial<AgentDeps> = {},
): AgentDeps {
  return {
    provider,
    registry,
    ctx,
    model: "fake",
    mode: "auto",
    maxTurns: 10,
    contextBudgetTokens: 64000,
    compactAt: 0.8,
    approve: async () => true,
    ...over,
  };
}

function toolOutputs(messages: AgentMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content);
}

/** Run `fn` with DEEPCODER_STREAMING_TOOLS forced to a value, restoring after. */
async function withFlag(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DEEPCODER_STREAMING_TOOLS;
  if (value === undefined) delete process.env.DEEPCODER_STREAMING_TOOLS;
  else process.env.DEEPCODER_STREAMING_TOOLS = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_STREAMING_TOOLS;
    else process.env.DEEPCODER_STREAMING_TOOLS = prev;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("two read-only calls execute concurrently and results land in call order", async () => {
  await withFlag("1", async () => {
    const log = newLog();
    const gate = deferred();
    const reg = new ToolRegistry();
    reg.register(readTool("read_a", log, gate.promise));
    reg.register(readTool("read_b", log, gate.promise));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_a", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_b", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "assistant_text_delta", text: "done" }, { type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    const runP = runAgentLoop(messages, deps(provider, reg, await ctxFor()));

    // Both reads are in flight together (gate still closed) → genuine concurrency.
    await waitUntil(() => log.active === 2, 1000, "both reads in flight");
    assert.equal(log.maxActive, 2);

    gate.resolve();
    const final = await runP;
    assert.equal(final, "done");

    // Results appended strictly in call-index order.
    assert.deepEqual(toolOutputs(messages), ["out:read_a", "out:read_b"]);
  });
});

test("result order is preserved even when reads finish out of order", async () => {
  await withFlag("1", async () => {
    const log = newLog();
    const gateA = deferred();
    const gateB = deferred();
    const reg = new ToolRegistry();
    reg.register(readTool("read_a", log, gateA.promise));
    reg.register(readTool("read_b", log, gateB.promise));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_a", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_b", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    const runP = runAgentLoop(messages, deps(provider, reg, await ctxFor()));

    await waitUntil(() => log.active === 2, 1000, "both reads in flight");
    // call 1 (read_b) finishes FIRST, call 0 (read_a) later.
    gateB.resolve();
    await new Promise((r) => setTimeout(r, 5));
    gateA.resolve();
    await runP;

    // History order follows call index, not completion order.
    assert.deepEqual(toolOutputs(messages), ["out:read_a", "out:read_b"]);
  });
});

test("a mutate call drains earlier in-flight reads before it runs (no overlap)", async () => {
  await withFlag("1", async () => {
    const log = newLog();
    const gate = deferred();
    const reg = new ToolRegistry();
    reg.register(readTool("read_a", log, gate.promise));
    reg.register(writeTool("write_b", log));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_a", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "write_b", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    const runP = runAgentLoop(messages, deps(provider, reg, await ctxFor()));

    // The read is in flight; the write must NOT have started (drain-before-exclusive).
    await waitUntil(() => log.events.includes("start:read_a"), 1000, "read started");
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!log.events.includes("start:write_b"), "write must wait for the in-flight read to drain");

    gate.resolve();
    await runP;

    // Strict, non-overlapping ordering: read fully completes before write starts.
    assert.deepEqual(log.events, ["start:read_a", "end:read_a", "start:write_b", "end:write_b"]);
    assert.deepEqual(toolOutputs(messages), ["out:read_a", "out:write_b"]);
  });
});

test("flag OFF uses the serial path and produces identical history", async () => {
  // No flag → serial. Gates pre-resolved so tools complete immediately.
  await withFlag(undefined, async () => {
    const log = newLog();
    const reg = new ToolRegistry();
    reg.register(readTool("read_a", log, Promise.resolve()));
    reg.register(readTool("read_b", log, Promise.resolve()));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_a", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_b", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "assistant_text_delta", text: "done" }, { type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    const final = await runAgentLoop(messages, deps(provider, reg, await ctxFor()));
    assert.equal(final, "done");
    // Serial: reads ran strictly one-at-a-time (never concurrent).
    assert.equal(log.maxActive, 1, "serial path must never run reads concurrently");
    assert.deepEqual(log.events, ["start:read_a", "end:read_a", "start:read_b", "end:read_b"]);
    assert.deepEqual(toolOutputs(messages), ["out:read_a", "out:read_b"]);
  });
});
