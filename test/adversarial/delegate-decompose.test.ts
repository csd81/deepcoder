/**
 * Phase 9O — model-driven task decomposer. SEED (red-first) anchor: pins the
 * core safety contract (validateDecomposition rejects a dependsOn cycle) so a
 * delegated worker MUST implement the pure decomposer (no green-check no-op),
 * then EXTENDS this file with the remaining validation/generation cases from
 * plans/phase9o-model-driven-task-decomposer-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition, proposeDecomposition, SubTaskSpec } from "../../src/delegate/decompose.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";

function subtask(id: string, dependsOn: string[], overrides: Partial<SubTaskSpec> = {}): SubTaskSpec {
  return {
    id, title: id.toUpperCase(), goal: "do " + id,
    deliverables: [{ id: id + "-d", acceptance: "x" }],
    allowedPaths: ["src/"], testCommand: "node --test t.test.ts",
    dependsOn, checkName: "phase",
    ...overrides
  };
}

test("[decompose-cycle] validateDecomposition rejects a dependsOn cycle", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", ["b"]), subtask("b", ["a"])],
  };
  const result = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(result.ok, false, "a dependency cycle must be rejected");
});

test("rejects an over-count decomposition (> bound)", () => {
  const subtasks = Array.from({ length: 13 }, (_, i) => subtask(`t${i}`, []));
  const plan = { task: "t", source: "model" as const, warnings: [], subtasks };
  const result = validateDecomposition(plan, { checks: ["phase"], maxSubTasks: 12 });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Too many sub-tasks/);
});

test("rejects a sub-task whose allowedPaths escape the repo OR hit a sensitive/generated path", () => {
  const plan1 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: ["../outside"] })],
  };
  const res1 = validateDecomposition(plan1, { checks: ["phase"] });
  assert.equal(res1.ok, false);
  assert.match(res1.errors[0], /escapes the repo/);

  const plan2 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: [".env"] })],
  };
  const res2 = validateDecomposition(plan2, { checks: ["phase"] });
  assert.equal(res2.ok, false);
  assert.match(res2.errors[0], /sensitive or generated/);

  const plan3 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { allowedPaths: ["node_modules/foo"] })],
  };
  const res3 = validateDecomposition(plan3, { checks: ["phase"] });
  assert.equal(res3.ok, false);
  assert.match(res3.errors[0], /sensitive or generated/);
});

test("rejects a NON-VERIFIABLE sub-task (no deliverable / no testCommand)", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { deliverables: [], testCommand: undefined })],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /non-verifiable/);
});

test("rejects an unknown checkName; rejects duplicate/unsafe ids", () => {
  const plan1 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", [], { checkName: "unknown" })],
  };
  const res1 = validateDecomposition(plan1, { checks: ["phase"] });
  assert.equal(res1.ok, false);
  assert.match(res1.errors[0], /unknown checkName/);

  const plan2 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", []), subtask("a", [])],
  };
  const res2 = validateDecomposition(plan2, { checks: ["phase"] });
  assert.equal(res2.ok, false);
  assert.match(res2.errors[0], /Duplicate sub-task id/);

  const plan3 = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a/b", [])],
  };
  const res3 = validateDecomposition(plan3, { checks: ["phase"] });
  assert.equal(res3.ok, false);
  assert.match(res3.errors[0], /Invalid sub-task id/);
});

test("flags overlapping allowedPaths between independent sub-tasks (warning)", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [
      subtask("a", [], { allowedPaths: ["src/shared.ts"] }),
      subtask("b", [], { allowedPaths: ["src/shared.ts"] }),
    ],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, true);
  assert.equal(res.plan?.warnings.length, 1);
  assert.match(res.plan!.warnings[0], /overlapping allowedPaths/);
});

test("a valid decomposition passes and is topologically orderable", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [
      subtask("a", []),
      subtask("b", ["a"]),
      subtask("c", ["a"]),
      subtask("d", ["b", "c"]),
    ],
  };
  const res = validateDecomposition(plan, { checks: ["phase"] });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("malformed model JSON -> proposeDecomposition falls back to heuristic buildPlan (warning, never throws)", async () => {
  const deps = {
    generate: async () => "not json"
  };
  const plan = await proposeDecomposition("do something", {}, deps, { checks: ["phase"] });
  assert.equal(plan.source, "heuristic");
  assert.equal(plan.warnings.length > 0, true);
  assert.match(plan.warnings[0], /fell back to heuristic/);
});

test("invalid model plan -> proposeDecomposition falls back to heuristic buildPlan", async () => {
  const deps = {
    generate: async () => JSON.stringify({
      task: "t", source: "model", warnings: [],
      subtasks: [subtask("a", ["b"]), subtask("b", ["a"])] // cycle
    })
  };
  const plan = await proposeDecomposition("do something", {}, deps, { checks: ["phase"] });
  assert.equal(plan.source, "heuristic");
  assert.equal(plan.warnings.length > 0, true);
  assert.match(plan.warnings[0], /fell back to heuristic/);
});
