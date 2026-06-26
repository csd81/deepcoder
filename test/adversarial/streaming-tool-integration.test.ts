import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentDeps } from "../../src/agent/agentLoop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type {
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ModelProvider,
} from "../../src/providers/types.js";
import { InvalidArgumentsError, type Tool, type ToolContext } from "../../src/tools/types.js";

// ── harness ───────────────────────────────────────────────────────────────────

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

async function waitUntil(cond: () => boolean, ms = 1000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function ctxFor(over: Partial<ToolContext> = {}): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "stream-adv-"));
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

/** A read-only tool that records execution and (optionally) waits on a gate. */
function spyTool(name: string, executed: string[], gate?: Promise<void>): Tool {
  return {
    name,
    description: name,
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => ({
      kind: "read-only",
      describe: () => name,
      execute: async () => {
        executed.push(name);
        if (gate) await gate;
        return { output: `out:${name}` };
      },
    }),
  };
}

/** A read-only tool whose build() always rejects the args. */
function invalidArgsTool(name: string, executed: string[]): Tool {
  return {
    name,
    description: name,
    kind: "read-only",
    rawSchema: { type: "object" },
    build: () => {
      throw new InvalidArgumentsError(name, "always invalid");
    },
  };
}

function toolOutputs(messages: AgentMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content);
}

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

test("[SECURITY] a permission-denied call yields a synthetic result and never executes (streaming)", async () => {
  await withFlag("1", async () => {
    const executed: string[] = [];
    const reg = new ToolRegistry();
    // A mutate tool under mode "readonly" is denied by policy.
    reg.register({
      name: "mutator",
      description: "mutator",
      kind: "mutate",
      rawSchema: { type: "object" },
      build: () => ({
        kind: "mutate",
        describe: () => "mutator",
        affectedPaths: [],
        execute: async () => {
          executed.push("mutator");
          return { output: "should-not-run" };
        },
      }),
    });
    reg.register(spyTool("read_ok", executed));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "mutator", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_ok", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop(messages, deps(provider, reg, await ctxFor(), { mode: "readonly" }));

    assert.ok(!executed.includes("mutator"), "denied tool must never execute");
    const outs = toolOutputs(messages);
    assert.equal(outs.length, 2, "both calls produced a result");
    assert.match(outs[0], /Denied by permission policy/);
    assert.equal(outs[1], "out:read_ok", "the later read still ran and landed in order");
  });
});

test("[SECURITY] an invalid-args call yields a synthetic result and never executes (streaming)", async () => {
  await withFlag("1", async () => {
    const executed: string[] = [];
    const reg = new ToolRegistry();
    reg.register(invalidArgsTool("bad_tool", executed));
    reg.register(spyTool("read_ok", executed));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "bad_tool", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_ok", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop(messages, deps(provider, reg, await ctxFor()));

    assert.deepEqual(executed, ["read_ok"], "invalid-args tool must never execute");
    const outs = toolOutputs(messages);
    assert.match(outs[0], /invalid arguments/i);
    assert.equal(outs[1], "out:read_ok");
  });
});

test("[SECURITY] an unknown / deferred-unexposed call yields a synthetic result and never executes (streaming)", async () => {
  await withFlag("1", async () => {
    const executed: string[] = [];
    const reg = new ToolRegistry();
    reg.register(spyTool("read_ok", executed));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "no_such_tool", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_ok", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop(messages, deps(provider, reg, await ctxFor()));

    assert.deepEqual(executed, ["read_ok"]);
    const outs = toolOutputs(messages);
    assert.match(outs[0], /Unknown tool/);
    assert.equal(outs[1], "out:read_ok");
  });
});

test("[SECURITY] a PreToolUse hook deny blocks the tool under the streaming path", async () => {
  await withFlag("1", async () => {
    const executed: string[] = [];
    const reg = new ToolRegistry();
    reg.register({
      name: "mutator",
      description: "mutator",
      kind: "mutate",
      rawSchema: { type: "object" },
      build: () => ({
        kind: "mutate",
        describe: () => "mutator",
        affectedPaths: [],
        execute: async () => {
          executed.push("mutator");
          return { output: "should-not-run" };
        },
      }),
    });
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "mutator", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop(
      messages,
      deps(provider, reg, await ctxFor(), {
        onPreToolUse: async () => ({ decision: "deny", reason: "nope" }),
      }),
    );
    assert.ok(!executed.includes("mutator"), "hook-denied tool must never execute");
    assert.match(toolOutputs(messages)[0], /Blocked by hook/);
  });
});

test("[SECURITY] user abort mid-flight stops pending tools (streaming)", async () => {
  await withFlag("1", async () => {
    const executed: string[] = [];
    const ac = new AbortController();
    const firstStarted = deferred();
    const gate = deferred();
    const reg = new ToolRegistry();
    // First read signals it started, then blocks until aborted/gate.
    reg.register({
      name: "read_first",
      description: "read_first",
      kind: "read-only",
      rawSchema: { type: "object" },
      build: () => ({
        kind: "read-only",
        describe: () => "read_first",
        execute: async () => {
          executed.push("read_first");
          firstStarted.resolve();
          await gate.promise;
          return { output: "out:read_first" };
        },
      }),
    });
    reg.register(spyTool("read_second", executed));
    reg.register(spyTool("read_third", executed));
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_first", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_second", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "3", name: "read_third", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const ctx = await ctxFor({ signal: ac.signal });
    // Read-concurrency 1 so read_second / read_third stay strictly pending while
    // read_first holds the only slot — then abort must prevent them from running.
    const prevConc = process.env.DEEPCODER_TOOL_READ_CONCURRENCY;
    process.env.DEEPCODER_TOOL_READ_CONCURRENCY = "1";
    try {
      const messages: AgentMessage[] = [{ role: "user", content: "go" }];
      const runP = runAgentLoop(messages, deps(provider, reg, ctx));
      await firstStarted.promise;
      ac.abort(); // user hits Ctrl-C while read_first is in flight
      gate.resolve(); // let read_first settle
      const final = await runP;
      assert.equal(final, "", "aborted run returns empty");
      assert.ok(!executed.includes("read_second"), "pending tool must not start after abort");
      assert.ok(!executed.includes("read_third"), "pending tool must not start after abort");
    } finally {
      if (prevConc === undefined) delete process.env.DEEPCODER_TOOL_READ_CONCURRENCY;
      else process.env.DEEPCODER_TOOL_READ_CONCURRENCY = prevConc;
    }
  });
});

test("[SECURITY] flag OFF is the serial path — model text cannot force concurrency", async () => {
  // With the flag off, even a streaming provider runs tools serially. This proves
  // the experimental concurrency cannot be switched on by anything but the env gate.
  await withFlag("0", async () => {
    const executed: string[] = [];
    let maxActive = 0;
    let active = 0;
    const gate = deferred();
    const reg = new ToolRegistry();
    const mk = (name: string): Tool => ({
      name,
      description: name,
      kind: "read-only",
      rawSchema: { type: "object" },
      build: () => ({
        kind: "read-only",
        describe: () => name,
        execute: async () => {
          executed.push(name);
          active += 1;
          maxActive = Math.max(maxActive, active);
          // Only the first call awaits the gate; if serial, the second never starts
          // until the first returns, so we must NOT block forever — resolve quickly.
          await Promise.resolve();
          active -= 1;
          return { output: `out:${name}` };
        },
      }),
    });
    reg.register(mk("read_a"));
    reg.register(mk("read_b"));
    void gate;
    const provider = new StreamingScriptedProvider([
      [
        { type: "tool_call_complete", toolCall: { id: "1", name: "read_a", arguments: {} } },
        { type: "tool_call_complete", toolCall: { id: "2", name: "read_b", arguments: {} } },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop(messages, deps(provider, reg, await ctxFor()));
    assert.equal(maxActive, 1, "serial path never overlaps tool executions");
    assert.deepEqual(executed, ["read_a", "read_b"]);
    assert.deepEqual(toolOutputs(messages), ["out:read_a", "out:read_b"]);
  });
});
