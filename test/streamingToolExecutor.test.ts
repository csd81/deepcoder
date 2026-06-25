import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StreamingToolExecutor,
  type ExecutionLane,
  type StreamingToolExecutorDeps,
} from "../src/agent/streamingToolExecutor.js";
import type { ToolCall } from "../src/providers/types.js";
import type { ToolResult } from "../src/tools/types.js";

// ── helpers ───────────────────────────────────────────────────────────────

function call(name: string, id = name): ToolCall {
  return { id, name, arguments: {} };
}

/** A manually-resolvable promise. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending microtasks/timeouts drain. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Default authorize that always allows. */
const allow: StreamingToolExecutorDeps["authorize"] = async () => ({ ok: true });

/** classify by name prefix: "read*" → read, else exclusive. */
function classifyByName(c: ToolCall): ExecutionLane {
  return c.name.startsWith("read") ? "read" : "exclusive";
}

// ── tests ───────────────────────────────────────────────────────────────────

test("two read calls both start before finishAssistant / before the slower resolves", async () => {
  const d0 = deferred<ToolResult>();
  const d1 = deferred<ToolResult>();
  const started: string[] = [];

  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: allow,
    execute: async (c) => {
      started.push(c.name);
      return c.name === "read0" ? d0.promise : d1.promise;
    },
  });

  ex.accept(call("read0"));
  ex.accept(call("read1"));
  await tick();

  // Both reads began even though neither has resolved and finishAssistant
  // has not been called.
  assert.deepEqual(started.sort(), ["read0", "read1"]);

  d0.resolve({ output: "a" });
  d1.resolve({ output: "b" });
  ex.finishAssistant();
  const results = await ex.results();
  assert.deepEqual(
    results.map((r) => r.output),
    ["a", "b"],
  );
});

test("reads finish out of order but results() is in call-index order", async () => {
  const d0 = deferred<ToolResult>();
  const d1 = deferred<ToolResult>();

  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: allow,
    execute: async (c) => (c.name === "read0" ? d0.promise : d1.promise),
  });

  ex.accept(call("read0"));
  ex.accept(call("read1"));
  ex.finishAssistant();

  // call 1 resolves FIRST, call 0 later.
  d1.resolve({ output: "one" });
  await tick();
  d0.resolve({ output: "zero" });

  const results = await ex.results();
  assert.deepEqual(
    results.map((r) => r.output),
    ["zero", "one"],
  );
});

test("exclusive calls run serially (no two exclusive executes overlap)", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const ex = new StreamingToolExecutor({
    classify: () => "exclusive",
    authorize: allow,
    execute: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick();
      concurrent -= 1;
      return { output: "done" };
    },
  });

  ex.accept(call("write0"));
  ex.accept(call("write1"));
  ex.accept(call("write2"));
  ex.finishAssistant();

  await ex.results();
  assert.equal(maxConcurrent, 1);
});

test("a read after an exclusive waits for the exclusive (barrier)", async () => {
  const exclusiveDone = deferred<ToolResult>();
  const order: string[] = [];
  let exclusiveFinished = false;

  const ex = new StreamingToolExecutor({
    classify: classifyByName,
    authorize: allow,
    execute: async (c) => {
      order.push(`start:${c.name}`);
      if (c.name === "write0") {
        const r = await exclusiveDone.promise;
        exclusiveFinished = true;
        return r;
      }
      // The later read must not start until the exclusive has finished.
      assert.equal(exclusiveFinished, true, `${c.name} started before exclusive finished`);
      return { output: c.name };
    },
  });

  ex.accept(call("write0"));
  ex.accept(call("read1"));
  ex.finishAssistant();

  await tick();
  // read1 must not have started yet (barrier).
  assert.deepEqual(order, ["start:write0"]);

  exclusiveDone.resolve({ output: "w" });
  await ex.results();
  assert.deepEqual(order, ["start:write0", "start:read1"]);
});

test("authorize -> {ok:false} yields the synthetic result at the right index and never executes", async () => {
  const executed: string[] = [];

  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: async (c) =>
      c.name === "denied"
        ? { ok: false, result: { output: "DENIED", isError: true } }
        : { ok: true },
    execute: async (c) => {
      executed.push(c.name);
      return { output: c.name };
    },
  });

  ex.accept(call("read0"));
  ex.accept(call("denied"));
  ex.accept(call("read2"));
  ex.finishAssistant();

  const results = await ex.results();
  assert.deepEqual(
    results.map((r) => r.output),
    ["read0", "DENIED", "read2"],
  );
  assert.equal(results[1].isError, true);
  // execute was never called for the denied call.
  assert.deepEqual(executed.sort(), ["read0", "read2"]);
});

test("execute-lane error aborts in-flight sibling work when abortSiblingExecuteOnError", async () => {
  const readStarted = deferred<void>();
  let siblingSignalFired = false;
  const readResolved = deferred<ToolResult>();

  const ex = new StreamingToolExecutor({
    classify: classifyByName,
    authorize: allow,
    execute: async (c, signal) => {
      if (c.name === "read0") {
        readStarted.resolve();
        signal.addEventListener("abort", () => {
          siblingSignalFired = true;
          readResolved.resolve({ output: "aborted-read", isError: true });
        });
        return readResolved.promise;
      }
      // exclusive that fails — should abort the in-flight read sibling.
      return { output: "boom", isError: true };
    },
  });

  ex.accept(call("read0"));
  ex.accept(call("writeFail"));
  ex.finishAssistant();

  await readStarted.promise; // ensure the read is genuinely in flight
  const results = await ex.results();

  assert.equal(siblingSignalFired, true);
  assert.equal(results[1].output, "boom");
  assert.equal(results[1].isError, true);
});

test("zero calls -> results() resolves to []", async () => {
  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: allow,
    execute: async () => ({ output: "x" }),
  });
  ex.finishAssistant();
  assert.deepEqual(await ex.results(), []);
});

test("readConcurrency caps concurrent reads (limit 2, 4 reads -> max 2 in flight)", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];

  const ex = new StreamingToolExecutor({
    readConcurrency: 2,
    classify: () => "read",
    authorize: allow,
    execute: async (c) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const idx = Number(c.name.slice(4)); // "read<n>"
      await gates[idx].promise;
      concurrent -= 1;
      return { output: c.name };
    },
  });

  for (let i = 0; i < 4; i++) ex.accept(call(`read${i}`));
  ex.finishAssistant();

  await tick();
  assert.equal(maxConcurrent, 2, "no more than 2 reads should be in flight");

  // Release one slot at a time; the cap must hold throughout.
  gates[0].resolve();
  await tick();
  assert.ok(maxConcurrent <= 2);
  gates[1].resolve();
  gates[2].resolve();
  gates[3].resolve();

  const results = await ex.results();
  assert.equal(results.length, 4);
  assert.equal(maxConcurrent, 2);
});
