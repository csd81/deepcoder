/**
 * Phase 9O — model-driven task decomposer. SEED (red-first) anchor: pins the
 * core safety contract (validateDecomposition rejects a dependsOn cycle) so a
 * delegated worker MUST implement the pure decomposer (no green-check no-op),
 * then EXTENDS this file with the remaining validation/generation cases from
 * plans/phase9o-model-driven-task-decomposer-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition } from "../../src/delegate/decompose.js";

function subtask(id: string, dependsOn: string[]) {
  return {
    id, title: id.toUpperCase(), goal: "do " + id,
    deliverables: [{ id: id + "-d", acceptance: "x" }],
    allowedPaths: ["src/"], testCommand: "node --test t.test.ts",
    dependsOn, checkName: "phase",
  };
}

test("[decompose-cycle] validateDecomposition rejects a dependsOn cycle", () => {
  const plan = {
    task: "t", source: "model" as const, warnings: [],
    subtasks: [subtask("a", ["b"]), subtask("b", ["a"])],
  };
  const result = validateDecomposition(plan, { checks: { phase: { command: "x" } } });
  assert.equal(result.ok, false, "a dependency cycle must be rejected");
});
