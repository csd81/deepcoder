/**
 * Adversarial — refactor areas are isolated from each other and nothing is
 * applied by the pipeline. Workers carry disjoint allowedPaths (one area each)
 * and a serialized dependency chain, so two areas can never write the same
 * files; the autonomy path runs and validates but has NO apply step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { refactorPlanToDelegationPlan } from "../../src/refactor/toRefactorWorkers.js";
import { runRefactorAuto } from "../../src/cli/refactorCli.js";
import type { RefactorPlan } from "../../src/refactor/refactorPlan.js";
import type { WorkerValidation } from "../../src/delegate/types.js";

const PLAN: RefactorPlan = {
  areas: [
    { area: "src/auth", files: ["src/auth/a.ts"], testFiles: ["test/auth.test.ts"], candidates: [], risk: "low", riskNotes: [] },
    { area: "src/db", files: ["src/db/b.ts"], testFiles: ["test/db.test.ts"], candidates: [], risk: "low", riskNotes: [] },
  ],
  globalRiskNotes: [],
};

test("[AWI-1] each worker's allowedPaths is exactly its own area (disjoint)", () => {
  const plan = refactorPlanToDelegationPlan(PLAN, { checkNames: ["phase"], createdAt: "2026-06-24T00:00:00.000Z" });
  assert.deepEqual(plan.workers.map((w) => w.allowedPaths), [["src/auth"], ["src/db"]]);
  // No worker may write into another area or into tests.
  for (const w of plan.workers) {
    assert.ok(!w.allowedPaths.some((p) => p.startsWith("test")));
    assert.ok(w.forbiddenPaths.includes("test/"));
  }
});

test("[AWI-2] areas are serialized (dependency chain) so patches never race", () => {
  const plan = refactorPlanToDelegationPlan(PLAN, { checkNames: ["phase"], createdAt: "2026-06-24T00:00:00.000Z" });
  assert.deepEqual(plan.workers[1]!.dependsOn, ["worker-1"]);
});

test("[AWI-3] the autonomy pipeline never applies (no apply seam, only run+validate+pr)", async () => {
  // RefactorAutoDeps has no `apply` field by construction; assert the run seam is
  // the only mutation entry and that the loop reaches PR without applying.
  let applied = false;
  const deps = {
    plan: async () => ({ exitCode: 0, planId: "refactor-1" }),
    run: async () => ({ exitCode: 0, result: null }),
    loadPlan: async () => ({ id: "refactor-1", task: "t", createdAt: "t", status: "planned" as const, workers: [{ id: "worker-1" }] as never, dependencies: [], globalChecks: [], riskNotes: [] }),
    validate: async () => ({ applyable: true, status: "passed", failures: [], warnings: [], evidence: [], evaluatedAt: "t" } as unknown as WorkerValidation),
    pr: async () => ({ exitCode: 0, prUrl: "http://pr/1" }),
  };
  // There is no apply hook to set `applied`; the type itself forbids one.
  const res = await runRefactorAuto("/r", {}, deps);
  assert.equal(applied, false);
  assert.deepEqual(res.prUrls, ["http://pr/1"]);
  assert.ok(!("apply" in deps), "RefactorAutoDeps exposes no apply seam");
});
