import { test } from "node:test";
import assert from "node:assert/strict";
import type { SmokeCase, Executor, SmokeResult } from "../scripts/smoke.js";
import { formatResultLine } from "../scripts/smoke.js";

/**
 * Import the runner's core function and drive it directly (no subprocess).
 * The executor argument lets us inject success/failure without shelling out.
 */
async function runCase(
  c: SmokeCase,
  execute: Executor,
): Promise<SmokeResult> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const m = await import("../scripts/smoke.js");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return m.runCase(c, execute) as Promise<SmokeResult>;
}

test("[smoke-pass] runner reports PASS for a clean case", async () => {
  // An executor that resolves cleanly (exit 0)
  const cleanExecutor: Executor = async (_c, _timeout) => {
    return { exitCode: 0 };
  };

  const result = await runCase(
    { name: "clean-test", prompt: "hello" },
    cleanExecutor,
  );

  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.name, "clean-test");
});

test("[smoke-fail] runner reports FAIL for a crashing case", async () => {
  // An executor that rejects (simulates a crash)
  const crashExecutor: Executor = async (_c, _timeout) => {
    throw Object.assign(new Error("process crashed"), { code: 1, stderr: "FATAL: out of memory", signal: "SIGTERM" });
  };

  const result = await runCase(
    { name: "crash-test", prompt: "crash" },
    crashExecutor,
  );

  assert.equal(result.passed, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.error, "process crashed");
});

test("[smoke-fail-nonzero] runner reports FAIL for nonzero exit", async () => {
  // An executor that returns a nonzero exit code (simulates an error)
  const failExecutor: Executor = async (_c, _timeout) => {
    return { exitCode: 1, stderr: "something went wrong" };
  };

  const result = await runCase(
    { name: "fail-test", prompt: "fail" },
    failExecutor,
  );

  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 1);
});

test("[smoke-fail-timeout] runner reports FAIL for timeout scenario", async () => {
  // An executor that resolves with a timeout signal (SIGTERM on timeout)
  const timeoutExecutor: Executor = async (_c, _timeout) => {
    return { exitCode: null, signal: "SIGTERM", stderr: "" };
  };

  const result = await runCase(
    { name: "timeout-test", prompt: "hang" },
    timeoutExecutor,
  );

  assert.equal(result.passed, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
});

test("[smoke-report] a passing case renders a tick and no diagnostics", () => {
  const line = formatResultLine({ name: "ok", passed: true, exitCode: 0, durationMs: 5 });
  assert.match(line, /ok … ✓/);
  assert.doesNotMatch(line, /exit/);
});

test("[smoke-report] a failing case surfaces the captured stderr so CI is diagnosable", () => {
  // The whole point: when a case crashes in CI, the operator must SEE why.
  const line = formatResultLine({
    name: "list-files",
    passed: false,
    exitCode: 1,
    durationMs: 5,
    error: "Error: Cannot find module 'tsx'\n    at boot (main.ts:1)",
  });
  assert.match(line, /list-files … ✗ \(exit 1\)/);
  assert.match(line, /Cannot find module 'tsx'/, "the failure reason must be printed, not swallowed");
  assert.match(line, /at boot/, "the stack detail must be printed too");
});

test("[smoke-report] a signalled failure shows the signal alongside the exit tag", () => {
  const line = formatResultLine({
    name: "hang",
    passed: false,
    exitCode: null,
    durationMs: 5,
    signal: "SIGTERM",
  });
  assert.match(line, /hang … ✗ \(exit null SIGTERM\)/);
});
