/**
 * Adversarial — the behavior-preserving stamp is enforced by the REAL 9-gate
 * validator, not by a prompt. A refactor worker that touches a test, ships a
 * test-only patch, or turns the frozen suite red must be NON-applyable, so the
 * PR gate refuses it. The stamp lives in toRefactorWorkers and is re-checked by
 * validateWorkerResult — it cannot be bypassed from the worker side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { refactorPlanToDelegationPlan } from "../../src/refactor/toRefactorWorkers.js";
import type { RefactorPlan } from "../../src/refactor/refactorPlan.js";
import { validateWorkerResult } from "../../src/delegate/validation.js";
import type { DelegationPlan, WorkerTask, WorkerRun } from "../../src/delegate/types.js";

const PLAN: RefactorPlan = {
  areas: [{
    area: "src/auth",
    files: ["src/auth/login.ts"],
    testFiles: ["test/auth.test.ts"],
    candidates: [],
    risk: "low",
    riskNotes: [],
  }],
  globalRiskNotes: [],
};

function delegationPlan(): DelegationPlan {
  return refactorPlanToDelegationPlan(PLAN, { checkNames: ["phase"], createdAt: "2026-06-24T00:00:00.000Z" });
}

/** Minimal unified diff editing one path (trailing newline included). */
function diff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    "-const x = 1;",
    "+const x = 2;",
    " export {};",
    "",
  ].join("\n");
}

function run(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    planId: "refactor-x", workerId: "worker-1", sessionId: "s", worktreePath: "/wt",
    startedAt: "t0", finishedAt: "t1", exitCode: 0, checkPassed: true,
    changedFiles: ["src/auth/login.ts"], patchPath: "/p", patchSha256: "sha",
    summary: "", warnings: [],
    isolation: { backend: "git-worktree", mode: "runner-owned", realRoot: "/r", isolatedRoot: "/wt", kept: false, cleaned: true },
    ...over,
  };
}

function validate(worker: WorkerTask, patchText: string, r: WorkerRun) {
  return validateWorkerResult({
    root: "/r",
    plan: delegationPlan(),
    worker: { ...worker, status: "passed" },
    run: r,
    patchText,
    alreadyChangedPaths: [],
    qualityGateRequired: false,
    fileExists: () => true,
  });
}

test("[ABP-1] a worker patch that edits a test file is NOT applyable (forbidden_path)", () => {
  const worker = delegationPlan().workers[0]!;
  const v = validate(worker, diff("test/auth.test.ts"), run({ changedFiles: ["test/auth.test.ts"] }));
  assert.equal(v.applyable, false);
  assert.ok(
    v.failures.some((f) => f.code === "patch_validation_failed" && /forbidden_path/.test(f.message)),
    "Gate 3 forbidden_path must fire on a test edit",
  );
});

test("[ABP-2] frozen suite goes red (checkPassed=false) → check_failed, not applyable", () => {
  const worker = delegationPlan().workers[0]!;
  const v = validate(worker, diff("src/auth/login.ts"), run({ checkPassed: false }));
  assert.equal(v.applyable, false);
  assert.ok(v.failures.some((f) => f.code === "check_failed"));
});

test("[ABP-3] empty patch → empty_patch, not applyable", () => {
  const worker = delegationPlan().workers[0]!;
  const v = validate(worker, "", run({ changedFiles: [] }));
  assert.equal(v.applyable, false);
  assert.ok(v.failures.some((f) => f.code === "empty_patch"));
});

test("[ABP-4] positive control: production-only patch, tests frozen + green → applyable", () => {
  const worker = delegationPlan().workers[0]!;
  const v = validate(worker, diff("src/auth/login.ts"), run());
  assert.equal(v.applyable, true, `expected applyable; failures: ${JSON.stringify(v.failures)}`);
});
