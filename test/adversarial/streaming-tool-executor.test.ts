import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StreamingToolExecutor,
  type ExecutionLane,
  type StreamingToolExecutorDeps,
} from "../../src/agent/streamingToolExecutor.js";
import type { ToolCall } from "../../src/providers/types.js";
import type { ToolResult } from "../../src/tools/types.js";

function call(name: string, id = name): ToolCall {
  return { id, name, arguments: {} };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const allow: StreamingToolExecutorDeps["authorize"] = async () => ({ ok: true });

function classifyByName(c: ToolCall): ExecutionLane {
  return c.name.startsWith("read") ? "read" : "exclusive";
}

test("[SECURITY] a read call cannot upgrade to skip authorize: execute set is a subset of authorized-ok set", async () => {
  const authorized = new Set<string>();
  const executed = new Set<string>();

  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: async (c) => {
      // Deny read2 and read5 to keep the authorized / executed sets distinct.
      const ok = !(c.name.endsWith("2") || c.name.endsWith("5"));
      if (ok) authorized.add(c.name);
      return ok ? { ok: true } : { ok: false, result: { output: "no", isError: true } };
    },
    execute: async (c) => {
      executed.add(c.name);
      return { output: c.name };
    },
  });

  for (let i = 0; i < 6; i++) ex.accept(call(`read${i}`));
  ex.finishAssistant();
  await ex.results();

  // Every executed call was authorized first; nothing slipped past.
  for (const name of executed) {
    assert.ok(authorized.has(name), `${name} executed without being authorized`);
  }
  // The denied calls (…2) were never executed.
  assert.equal(executed.has("read2"), false);
  assert.equal(executed.has("read5"), false);
});

test("[SECURITY] a denied call does not grant approval to the call that follows it", async () => {
  const authorizeCalls: string[] = [];
  const executed: string[] = [];

  const ex = new StreamingToolExecutor({
    classify: () => "read",
    authorize: async (c) => {
      authorizeCalls.push(c.name);
      if (c.name === "denied") return { ok: false, result: { output: "denied", isError: true } };
      return { ok: true };
    },
    execute: async (c) => {
      executed.push(c.name);
      return { output: c.name };
    },
  });

  ex.accept(call("denied"));
  ex.accept(call("after"));
  ex.finishAssistant();
  await ex.results();

  // The later call ran its OWN authorize — approval is not inherited.
  assert.ok(authorizeCalls.includes("after"));
  assert.deepEqual(executed, ["after"]);
});

test("[SECURITY] parent signal abort mid-flight stops all in-flight executes and starts no new calls", async () => {
  const parent = new AbortController();
  const signalsFired: string[] = [];
  let lateExecuteStarted = false;
  let startedCount = 0;
  const bothStarted = deferred<void>();

  const slow = deferred<ToolResult>();

  const ex = new StreamingToolExecutor({
    readConcurrency: 2,
    classify: () => "read",
    authorize: allow,
    signal: parent.signal,
    execute: async (c, signal) => {
      if (c.name === "read0" || c.name === "read1") {
        signal.addEventListener("abort", () => {
          signalsFired.push(c.name);
        });
        startedCount += 1;
        if (startedCount === 2) bothStarted.resolve();
        return slow.promise; // stays in flight until abort
      }
      // Any later call must never actually execute after abort.
      lateExecuteStarted = true;
      return { output: c.name };
    },
  });

  ex.accept(call("read0"));
  ex.accept(call("read1"));
  ex.accept(call("read2")); // gated behind the concurrency cap (2)
  ex.accept(call("read3"));
  ex.finishAssistant();

  await bothStarted.promise;
  parent.abort();
  // Let aborted in-flight executes settle.
  slow.resolve({ output: "ignored" });

  const results = await ex.results();

  // The two in-flight reads saw their signal fire.
  assert.deepEqual(signalsFired.sort(), ["read0", "read1"]);
  // No new (gated) call ever entered execute().
  assert.equal(lateExecuteStarted, false);
  // Every call still produced a result so the loop can append them in order.
  assert.equal(results.length, 4);
  assert.equal(results[2].isError, true);
  assert.equal(results[3].isError, true);
});

test("[SECURITY] result-order fuzz: randomized resolution order still yields strictly index-ordered results", async () => {
  const N = 12;
  // Deterministic non-trivial resolution order (NOT Math.random): for each call,
  // pick a delay derived from a multiplicative permutation of its index so that
  // later-index calls frequently resolve before earlier-index ones.
  const deferreds = Array.from({ length: N }, () => deferred<ToolResult>());

  const ex = new StreamingToolExecutor({
    readConcurrency: N, // all reads can be in flight at once
    classify: () => "read",
    authorize: allow,
    execute: async (c) => {
      const idx = Number(c.name.slice(4));
      return deferreds[idx].promise;
    },
  });

  for (let i = 0; i < N; i++) ex.accept(call(`read${i}`));
  ex.finishAssistant();
  await tick();

  // Resolve in a scrambled but deterministic order: index*5 mod N (5 is coprime
  // to 12, so this visits every index exactly once in a shuffled sequence).
  for (let step = 0; step < N; step++) {
    const idx = (step * 5) % N;
    deferreds[idx].resolve({ output: String(idx) });
    await tick();
  }

  const results = await ex.results();
  assert.deepEqual(
    results.map((r) => r.output),
    Array.from({ length: N }, (_, i) => String(i)),
  );
});

test("[SECURITY] mutate/exclusive calls never overlap regardless of accept timing", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const ex = new StreamingToolExecutor({
    classify: classifyByName,
    authorize: allow,
    execute: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick();
      concurrent -= 1;
      return { output: "ok" };
    },
  });

  // Accept exclusive calls with arbitrary delays between them — the model
  // "wanting" parallelism must not be honored.
  ex.accept(call("write0"));
  await tick();
  ex.accept(call("write1"));
  ex.accept(call("write2"));
  await tick();
  ex.accept(call("write3"));
  ex.finishAssistant();

  await ex.results();
  assert.equal(maxConcurrent, 1);
});

test("[SECURITY] an exclusive failure does not let later calls execute (no leak past the barrier)", async () => {
  const executed: string[] = [];

  const ex = new StreamingToolExecutor({
    classify: classifyByName,
    authorize: allow,
    execute: async (c) => {
      executed.push(c.name);
      if (c.name === "writeFail") return { output: "fail", isError: true };
      return { output: c.name };
    },
  });

  ex.accept(call("writeFail"));
  ex.accept(call("read1"));
  ex.accept(call("write2"));
  ex.finishAssistant();

  const results = await ex.results();
  // The failing exclusive aborts the executor; the calls behind the barrier
  // never execute and get synthetic aborted results.
  assert.equal(executed.includes("writeFail"), true);
  assert.equal(executed.includes("read1"), false);
  assert.equal(executed.includes("write2"), false);
  assert.equal(results.length, 3);
  assert.equal(results[1].isError, true);
  assert.equal(results[2].isError, true);
});
