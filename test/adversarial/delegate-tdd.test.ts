/**
 * Phase 9L — TDD delegated workers. SEED (red-first) tests pinning the core
 * contract; the worker implements the modules to make these green and then adds
 * the remaining lifecycle/apply tests from the plan. No live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReproPhasePrompt, buildFixPhasePrompt } from "../../src/delegate/tddPrompts.js";
import { writeTddRecord, readTddRecord } from "../../src/delegate/tddArtifacts.js";
import type { WorkerTask, DelegationPlan, WorkerTddRun } from "../../src/delegate/types.js";

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "fix parser", prompt: "fix the parser bug", checkName: "phase",
    allowedPaths: ["src/parser.ts", "test/parser.test.ts"], forbiddenPaths: [], maxAttempts: 1,
    dependsOn: [], expectedOutputs: [], status: "planned",
    tdd: { required: true, allowedTestPaths: ["test/"] }, ...over,
  };
}
const plan: DelegationPlan = {
  id: "p1", task: "t", createdAt: "", status: "planned", workers: [worker()],
  dependencies: [], globalChecks: [], riskNotes: [],
};

test("buildReproPhasePrompt: test-only, forbids production edits, isolated", () => {
  const p = buildReproPhasePrompt(worker(), plan);
  assert.equal(typeof p, "string");
  assert.ok(p.length > 0);
  assert.match(p, /test/i);
  assert.match(p, /not|forbid|only/i, "must constrain to tests-only / forbid production edits");
});

test("buildFixPhasePrompt: notes the repro is confirmed-failing and must not be weakened", () => {
  const p = buildFixPhasePrompt(worker(), plan, "baseline failed as expected (exit 1)");
  assert.equal(typeof p, "string");
  assert.match(p, /repro|test/i);
  assert.match(p, /not (delete|weaken|remove)|preserve|keep/i, "must forbid weakening/deleting the repro");
});

test("tddArtifacts: writeTddRecord → readTddRecord round-trips the TDD run record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdd-"));
  try {
    const rec: WorkerTddRun = {
      required: true, status: "green_confirmed", reproPaths: ["test/parser.test.ts"],
      redRunId: "chk_red", greenRunId: "chk_green", warnings: [],
    };
    await writeTddRecord(root, "p1", "w1", rec);
    const loaded = await readTddRecord(root, "p1", "w1");
    assert.deepEqual(loaded, rec);
    // missing record → null (never throws)
    assert.equal(await readTddRecord(root, "p1", "nope"), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
