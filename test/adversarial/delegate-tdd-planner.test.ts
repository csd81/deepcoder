/**
 * Phase 9L.5 SEED (red) — planner --tdd makes delegated workers TDD-required.
 * Forces buildPlan to honor a `tdd` option; the worker implements to green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../../src/delegate/planner.js";

test("buildPlan({ tdd: true }) marks every worker tdd.required", () => {
  const plan = buildPlan("fix the null-deref bug in the parser", { tdd: true, checkNames: ["phase"] } as never);
  assert.ok(plan.workers.length >= 1);
  for (const w of plan.workers) {
    assert.equal(w.tdd?.required, true, `worker ${w.id} must be TDD-required under --tdd`);
  }
});

test("buildPlan without tdd leaves workers non-TDD (default, unchanged)", () => {
  const plan = buildPlan("fix a bug", { checkNames: ["phase"] });
  for (const w of plan.workers) {
    assert.equal(w.tdd, undefined, "no --tdd → no tdd requirement");
  }
});

test("buildPlan({ acceptanceFirst: true }) marks workers tdd.required AND requireProductionChange", () => {
  const plan = buildPlan("fix the parser bug", { acceptanceFirst: true, checkNames: ["phase"] } as never);
  assert.ok(plan.workers.length >= 1);
  for (const w of plan.workers) {
    assert.equal(w.tdd?.required, true, `worker ${w.id} must be TDD-required under acceptance-first`);
    assert.equal((w as { requireProductionChange?: boolean }).requireProductionChange, true, `worker ${w.id} must require a production change`);
  }
});

test("buildPlan without acceptanceFirst leaves requireProductionChange unset (default-safe)", () => {
  const plan = buildPlan("fix a bug", { checkNames: ["phase"] });
  for (const w of plan.workers) {
    assert.equal((w as { requireProductionChange?: boolean }).requireProductionChange, undefined);
  }
});
