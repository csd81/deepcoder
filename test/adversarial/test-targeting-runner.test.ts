/**
 * Phase 10H — automatic minimal test targeting. SEED (red-first): pins the pure
 * planner contract so the delegated worker MUST implement it (no no-op), then
 * extends this file with the remaining cases from the plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestTargetPlan } from "../../src/checks/testTargetPlanner.js";

test("a changed TEST file → high-confidence target", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["test/foo.test.ts"], maxTargets: 8 });
  assert.equal(plan.confidence, "high");
  assert.ok(plan.targetFiles.includes("test/foo.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

test("no derivable targets → fallbackRequired, confidence 'none'", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["README.md"], maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.confidence, "none");
});
