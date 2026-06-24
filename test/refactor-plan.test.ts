/**
 * Auto-refactor — deterministic refactor plan (pure; no model, no clock).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRefactorPlan } from "../src/refactor/refactorPlan.js";
import type { RepoStructure, AreaStructure } from "../src/refactor/discovery.js";

function area(over: Partial<AreaStructure> = {}): AreaStructure {
  return {
    area: "src/auth",
    files: ["src/auth/login.ts"],
    testFiles: ["test/auth.test.ts"],
    fanIn: 0,
    largeFiles: [],
    duplicateSymbols: [],
    ...over,
  };
}
function structure(areas: AreaStructure[]): RepoStructure {
  return { root: "/repo", areas, indexEmpty: areas.length === 0 };
}

test("[RP-1] same structure → byte-identical plan (deterministic)", () => {
  const s = structure([
    area({ area: "src/db", fanIn: 12, files: ["src/db/conn.ts"], testFiles: ["test/db.test.ts"] }),
    area({ area: "src/auth", duplicateSymbols: [{ name: "v", files: ["a.ts", "b.ts"] }] }),
  ]);
  const a = buildRefactorPlan(s);
  const b = buildRefactorPlan(s);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Areas sorted by path regardless of input order.
  assert.deepEqual(a.areas.map((x) => x.area), ["src/auth", "src/db"]);
});

test("[RP-2] candidate kinds are derived structurally", () => {
  const s = structure([
    area({
      area: "src/auth",
      duplicateSymbols: [{ name: "validate", files: ["src/auth/a.ts", "src/auth/b.ts"] }],
      largeFiles: [{ file: "src/auth/big.ts", symbolCount: 20 }],
      fanIn: 9, // ≥ SPLIT_MODULE_FANIN (8)
    }),
  ]);
  const kinds = buildRefactorPlan(s).areas[0]!.candidates.map((c) => c.kind);
  assert.ok(kinds.includes("dedupe"));
  assert.ok(kinds.includes("extract-helper"));
  assert.ok(kinds.includes("split-module"));
  // Sorted by kind for determinism.
  assert.deepEqual([...kinds].sort(), kinds);
});

test("[RP-3] zero-test area → high risk + explicit riskNote", () => {
  const plan = buildRefactorPlan(structure([area({ testFiles: [] })]));
  const a = plan.areas[0]!;
  assert.equal(a.risk, "high");
  assert.ok(a.riskNotes.some((n) => /cannot be proven preserved/i.test(n)));
  assert.ok(plan.globalRiskNotes.some((n) => /without covering tests/i.test(n)));
});

test("[RP-4] high fan-in but tested → medium; small + tested → low", () => {
  const med = buildRefactorPlan(structure([area({ fanIn: 15 })])).areas[0]!;
  assert.equal(med.risk, "medium");
  const low = buildRefactorPlan(structure([area({ fanIn: 1 })])).areas[0]!;
  assert.equal(low.risk, "low");
});

test("[RP-5] empty structure → no areas + a global note", () => {
  const plan = buildRefactorPlan(structure([]));
  assert.equal(plan.areas.length, 0);
  assert.ok(plan.globalRiskNotes.some((n) => /No refactorable areas/i.test(n)));
});
