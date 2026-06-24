/**
 * Adversarial — the refactor pipeline opens PRs but NEVER merges. The autonomy
 * surface has no merge seam at all, and the PR body it produces carries the
 * "never auto-merge" instruction so a human stays the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runRefactorAuto, runRefactorPr } from "../../src/cli/refactorCli.js";
import type { WorkerValidation } from "../../src/delegate/types.js";

const applyable = { applyable: true, status: "passed", failures: [], warnings: [], evidence: [], evaluatedAt: "t" } as unknown as WorkerValidation;

test("[ANM-1] runRefactorAuto records only plan/run/validate/pr — never a merge", async () => {
  const seen: string[] = [];
  await runRefactorAuto("/r", {}, {
    plan: async () => { seen.push("plan"); return { exitCode: 0, planId: "refactor-1" }; },
    run: async () => { seen.push("run"); return { exitCode: 0, result: null }; },
    loadPlan: async () => ({ id: "refactor-1", task: "t", createdAt: "t", status: "planned", workers: [{ id: "worker-1" }] as never, dependencies: [], globalChecks: [], riskNotes: [] }),
    validate: async () => { seen.push("validate"); return applyable; },
    pr: async () => { seen.push("pr"); return { exitCode: 0, prUrl: "http://pr/1" }; },
  });
  assert.deepEqual(seen, ["plan", "run", "validate", "pr"]);
  assert.ok(!seen.includes("merge"), "no merge step exists in the refactor pipeline");
});

test("[ANM-2] the PR body carries the never-auto-merge instruction", async () => {
  // runRefactorPr IS runDelegatePr; inject validate (applyable) + openPr capturing the body.
  let body = "";
  const res = await runRefactorPr("/r", "refactor-1", "worker-1", {}, {
    validate: async () => applyable,
    openPr: async (b: string) => { body = b; return "http://pr/1"; },
  });
  assert.equal(res.exitCode, 0);
  assert.match(body, /never auto-merge/i);
  assert.match(body, /review gate/i);
});
