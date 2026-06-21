/**
 * Phase 10H E2E — targeted-first fast-fail through the real solveRunner wiring
 * (git changed-files → buildTestTargetPlan → runTargetedChecks → preCheck).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveCommand } from "../src/cli/solveRunner.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { Session } from "../src/cli/repl.js";
import type { ChatResponse, ModelProvider } from "../src/providers/types.js";

const exec = promisify(execFile);
process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

const deadProvider: ModelProvider = {
  async chat(): Promise<ChatResponse> {
    throw new Error("provider must not be called");
  },
};

const testBody = (pass: boolean) =>
  `const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("t", () => { assert.equal(${pass ? 1 : 0}, 1); });\n`;

test("targeted-first fast-fails on a failing changed test, then solves once it passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solve-tgt-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["config", "user.email", "t@t"], { cwd: root });
    await exec("git", ["config", "user.name", "t"], { cwd: root });
    // Baseline: a passing test committed, so later edits show up as "changed".
    await writeFile(path.join(root, "thing.test.js"), testBody(true));
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });

    const telemetry = path.join(root, "telemetry.json");
    const config = loadConfig({
      workspaceRoot: root,
      apiKey: "fixture",
      approvalMode: "auto",
      checks: { full: { command: `node --test thing.test.js` } },
      solveTelemetry: telemetry,
    });
    // Enable targeted-first (default is off).
    config.testTargeting = { ...config.testTargeting, enabled: true, mode: "targeted-first" };

    const session: Session = {
      config,
      provider: deadProvider,
      registry: defaultRegistry(),
      store: new SessionStore(root, newSessionId()),
      messages: [{ role: "system", content: "sys" }],
      mode: "auto",
      todos: [],
      readTracker: new Set(),
      writeTracker: new Set(),
      reviews: [],
    };

    let attempt = 0;
    await runSolveCommand(session, { task: "fix the test", checkName: "full", maxAttempts: 3 }, async () => {
      attempt++;
      // attempt 1 leaves the test failing; attempt 2 makes it pass.
      await writeFile(path.join(root, "thing.test.js"), testBody(attempt >= 2));
    });

    const rec = JSON.parse(await readFile(telemetry, "utf8"));
    assert.equal(rec.solved, true, "solves once the targeted test passes and the full check confirms");
    assert.equal(rec.attempts.length, 2);
    // Attempt 1: the changed test failed → fast-fail, the authoritative check was skipped.
    assert.equal(rec.attempts[0].checkPassed, false);
    assert.equal(rec.attempts[0].checkRunId, null, "fast-fail ran no authoritative check on attempt 1");
    // Attempt 2: targeted passed → fell through to the authoritative check, which confirmed.
    assert.equal(rec.attempts[1].checkPassed, true);
    assert.ok(rec.attempts[1].checkRunId, "the authoritative check ran on the solving attempt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
