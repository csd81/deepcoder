import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSolveLoop } from "../../src/solve/solver.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { loadConfig } from "../../src/config/config.js";
import type { Session } from "../../src/cli/repl.js";
import type { ChatResponse, ModelProvider } from "../../src/providers/types.js";

// Phase 5C — solver-side repro-test generation. These are no-model, fake-deps
// integrations: `runReproTurn` writes a known test file and `runAgent` applies a
// known fix, so the solver's repro phase + verification run for real (via the
// shared, gated runner) without any provider call.

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

const deadProvider: ModelProvider = {
  async chat(): Promise<ChatResponse> {
    throw new Error("provider must not be called");
  },
};

function makeSession(root: string, checks: Record<string, { command: string }> = {}): Session {
  const config = loadConfig({ workspaceRoot: root, apiKey: "fixture", approvalMode: "auto", checks });
  return {
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
}

const REPRO_RED = [
  'import { test } from "node:test";',
  'import { strict as assert } from "node:assert";',
  'import { existsSync } from "node:fs";',
  'test("the bug is fixed", () => assert.ok(existsSync("fixed.txt"), "fixed.txt should exist"));',
  "",
].join("\n");

test("repro auto with no check: validated red repro becomes the oracle, fix turns it green", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repro-oracle-"));
  try {
    const session = makeSession(root); // no configured check
    let reproAt: string | undefined;
    let attempt = 0;
    const res = await runSolveLoop(
      session,
      { task: "fixed.txt is missing", maxAttempts: 4, repro: "auto" },
      {
        signal: new AbortController().signal,
        runReproTurn: async (reproPath) => {
          reproAt = reproPath;
          await writeFile(path.join(root, reproPath), REPRO_RED, "utf8");
        },
        runAgent: async () => {
          // The agent "fixes" the bug on its second fix attempt.
          if (++attempt === 2) await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
        },
      },
    );

    assert.equal(res.solved, true, "solved once the repro went green");
    assert.ok(res.repro, "repro outcome is reported");
    assert.equal(res.repro!.generated, true);
    assert.equal(res.repro!.valid, true);
    assert.equal(res.repro!.usedAsOracle, true, "the repro was the oracle (no check existed)");
    assert.equal(res.repro!.tautological, false);
    assert.equal(res.repro!.kept, false, "a scratch-path repro is discarded, not kept");
    // The scratch oracle file is cleaned up after the solve.
    assert.ok(reproAt && !existsSync(path.join(root, reproAt)), "scratch repro discarded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repro auto with no check: a repro that does not go red is rejected and the solve refuses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repro-notred-"));
  try {
    const session = makeSession(root);
    // This test PASSES on the buggy tree (no fixed.txt yet) → never red.
    const greenOnBuggy = [
      'import { test } from "node:test";',
      'import { strict as assert } from "node:assert";',
      'import { existsSync } from "node:fs";',
      'test("not red", () => assert.ok(!existsSync("fixed.txt")));',
      "",
    ].join("\n");
    let fixed = false;
    const res = await runSolveLoop(
      session,
      { task: "something is wrong", maxAttempts: 3, repro: "auto" },
      {
        signal: new AbortController().signal,
        runReproTurn: async (reproPath) => writeFile(path.join(root, reproPath), greenOnBuggy, "utf8"),
        runAgent: async () => {
          fixed = true; // would "fix", but the loop must never reach here
        },
      },
    );

    assert.equal(res.solved, false);
    assert.equal(fixed, false, "the fix loop never ran without a valid oracle");
    assert.ok(res.refusal && /passed on the buggy tree/.test(res.refusal), res.refusal);
    assert.equal(res.repro!.generated, true);
    assert.equal(res.repro!.valid, false);
    assert.equal(res.attempts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repro auto WITH a configured check: the check keeps authority and a non-scratch repro is kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repro-withcheck-"));
  try {
    const session = makeSession(root, {
      test: { command: `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"` },
    });
    let attempt = 0;
    const res = await runSolveLoop(
      session,
      { task: "fixed.txt is missing", checkName: "test", maxAttempts: 4, repro: "auto", reproPath: "tests/repro.test.mjs" },
      {
        signal: new AbortController().signal,
        runReproTurn: async (reproPath) => writeFile(path.join(root, reproPath), REPRO_RED, "utf8"),
        runAgent: async () => {
          if (++attempt === 1) await writeFile(path.join(root, "fixed.txt"), "ok", "utf8");
        },
      },
    );

    assert.equal(res.solved, true);
    assert.equal(res.repro!.valid, true);
    assert.equal(res.repro!.usedAsOracle, false, "the configured check stayed the authority");
    assert.equal(res.repro!.kept, true, "a valid non-scratch repro is kept as a regression test");
    assert.ok(existsSync(path.join(root, "tests/repro.test.mjs")), "kept repro remains on disk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repro auto with no check: a shallow/assertion-less repro is rejected by the tautology guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repro-taut-"));
  try {
    const session = makeSession(root);
    let fixed = false;
    const res = await runSolveLoop(
      session,
      { task: "bug", maxAttempts: 3, repro: "auto" },
      {
        signal: new AbortController().signal,
        // Exits non-zero (looks "red") but has no assertion → no real oracle.
        runReproTurn: async (reproPath) => writeFile(path.join(root, reproPath), "process.exit(1)\n", "utf8"),
        runAgent: async () => {
          fixed = true;
        },
      },
    );

    assert.equal(res.solved, false);
    assert.equal(fixed, false);
    assert.equal(res.repro!.tautological, true);
    assert.equal(res.repro!.valid, false);
    assert.ok(res.refusal && /no assertion/.test(res.refusal), res.refusal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
