/**
 * Auto-refactor — RefactorPlan → DelegationPlan mapping carries the
 * behavior-preserving stamp the validator enforces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { refactorPlanToDelegationPlan, FROZEN_TEST_PREFIXES } from "../src/refactor/toRefactorWorkers.js";
import type { RefactorPlan, RefactorArea } from "../src/refactor/refactorPlan.js";

function rArea(over: Partial<RefactorArea> = {}): RefactorArea {
  return {
    area: "src/auth",
    files: ["src/auth/login.ts"],
    testFiles: ["test/auth.test.ts"],
    candidates: [],
    risk: "low",
    riskNotes: [],
    ...over,
  };
}
function rPlan(areas: RefactorArea[]): RefactorPlan {
  return { areas, globalRiskNotes: [] };
}

const FIXED = "2026-06-24T00:00:00.000Z";

test("[RW-1] every worker freezes tests: forbiddenPaths + requireProductionChange", () => {
  const plan = refactorPlanToDelegationPlan(rPlan([rArea(), rArea({ area: "src/db", testFiles: ["test/db.test.ts"] })]), {
    checkNames: ["phase"],
    createdAt: FIXED,
  });
  for (const w of plan.workers) {
    for (const p of FROZEN_TEST_PREFIXES) assert.ok(w.forbiddenPaths.includes(p), `${p} forbidden`);
    assert.equal(w.requireProductionChange, true);
  }
});

test("[RW-2] no tdd seeding; checkName is the green-suite check", () => {
  const plan = refactorPlanToDelegationPlan(rPlan([rArea()]), { checkNames: ["phase", "lint"], createdAt: FIXED });
  const w = plan.workers[0]!;
  assert.equal(w.tdd, undefined, "must NOT seed new red tests");
  assert.equal(w.checkName, "phase");
  // expectedFiles freeze each covering test as must_not_change.
  assert.deepEqual(w.expectedFiles, [{ path: "test/auth.test.ts", mode: "must_not_change" }]);
});

test("[RW-2b] checkName falls back to first configured, then 'phase'", () => {
  assert.equal(refactorPlanToDelegationPlan(rPlan([rArea()]), { checkNames: ["build"], createdAt: FIXED }).workers[0]!.checkName, "build");
  assert.equal(refactorPlanToDelegationPlan(rPlan([rArea()]), { checkNames: [], createdAt: FIXED }).workers[0]!.checkName, "phase");
});

test("[RW-3] 1 area → 1 worker (no deps); N areas → serialized chain", () => {
  const one = refactorPlanToDelegationPlan(rPlan([rArea()]), { createdAt: FIXED });
  assert.equal(one.workers.length, 1);
  assert.deepEqual(one.workers[0]!.dependsOn, []);

  const three = refactorPlanToDelegationPlan(
    rPlan([rArea(), rArea({ area: "src/db" }), rArea({ area: "src/web" })]),
    { createdAt: FIXED },
  );
  assert.equal(three.workers.length, 3);
  assert.deepEqual(three.workers[1]!.dependsOn, ["worker-1"]);
  assert.deepEqual(three.workers[2]!.dependsOn, ["worker-2"]);
  assert.equal(three.dependencies.length, 2);
});

test("[RW-4] allowedPaths is exactly the area; deterministic plan id", () => {
  const plan = refactorPlanToDelegationPlan(rPlan([rArea()]), { createdAt: FIXED });
  assert.deepEqual(plan.workers[0]!.allowedPaths, ["src/auth"]);
  assert.equal(plan.id, "refactor-2026-06-24T00-00-00-000Z");
  assert.equal(plan.status, "planned");
});
