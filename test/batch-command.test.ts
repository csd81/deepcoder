import { test } from "node:test";
import assert from "node:assert/strict";
// [BATCH] red anchor on baseline: the module does not exist yet.
import { planFromDecomposition } from "../src/delegate/batchPlan.js";
import { buildRunnableBatches } from "../src/delegate/orchestrator.js";
import type { DecompositionPlan, SubTaskSpec } from "../src/delegate/decompose.js";

function sub(over: Partial<SubTaskSpec> & Pick<SubTaskSpec, "id">): SubTaskSpec {
  return {
    id: over.id,
    title: over.title ?? `task ${over.id}`,
    goal: over.goal ?? `do ${over.id}`,
    deliverables: over.deliverables ?? [],
    allowedPaths: over.allowedPaths ?? [`src/${over.id}/`],
    testCommand: over.testCommand,
    dependsOn: over.dependsOn ?? [],
    checkName: over.checkName ?? "phase",
  };
}
function decomp(subtasks: SubTaskSpec[]): DecompositionPlan {
  return { task: "the goal", subtasks, source: "heuristic", warnings: [] };
}

// [BATCH-1] every SubTaskSpec field maps onto the WorkerTask.
test("[BATCH-1] planFromDecomposition maps subtask fields to worker fields", () => {
  const plan = planFromDecomposition(decomp([
    sub({ id: "a", goal: "build A", allowedPaths: ["src/a/"], checkName: "phase", dependsOn: [] }),
  ]));
  assert.equal(plan.workers.length, 1);
  const w = plan.workers[0];
  assert.equal(w.id, "a");
  assert.equal(w.prompt, "build A", "prompt comes from the subtask goal");
  assert.deepEqual(w.allowedPaths, ["src/a/"]);
  assert.equal(w.checkName, "phase");
  assert.equal(w.status, "planned");
  // forbiddenPaths must shield node_modules + .deepcoder.
  assert.ok(w.forbiddenPaths.some((p) => p.includes("node_modules")));
  assert.ok(w.forbiddenPaths.some((p) => p.includes(".deepcoder")));
});

// [BATCH-2] a testCommand subtask becomes a TDD-required worker.
test("[BATCH-2] a testCommand subtask produces tdd.required + testCommand", () => {
  const plan = planFromDecomposition(decomp([sub({ id: "a", testCommand: "npm test -- a" })]));
  const w = plan.workers[0];
  assert.equal(w.tdd?.required, true);
  assert.equal((w.tdd as { testCommand?: string }).testCommand, "npm test -- a");

  const noTdd = planFromDecomposition(decomp([sub({ id: "b" })]));
  assert.equal(noTdd.workers[0].tdd, undefined, "no testCommand → no tdd");
});

// [BATCH-3] two independent subtasks with DISJOINT paths share a batch.
test("[BATCH-3] independent disjoint-path subtasks land in the SAME batch", () => {
  const plan = planFromDecomposition(decomp([
    sub({ id: "a", allowedPaths: ["src/a/"] }),
    sub({ id: "b", allowedPaths: ["src/b/"] }),
  ]));
  const batches = buildRunnableBatches(plan, { maxConcurrency: 2 });
  assert.equal(batches.length, 1, "both fit one parallel batch");
  assert.deepEqual(new Set(batches[0].workerIds), new Set(["a", "b"]));
});

// [BATCH-4] overlapping paths force DIFFERENT batches (lock conflict).
test("[BATCH-4] overlapping-path subtasks land in DIFFERENT batches", () => {
  const plan = planFromDecomposition(decomp([
    sub({ id: "a", allowedPaths: ["src/shared/"] }),
    sub({ id: "b", allowedPaths: ["src/shared/"] }),
  ]));
  const batches = buildRunnableBatches(plan, { maxConcurrency: 2 });
  assert.equal(batches.length, 2, "path conflict serializes them");
});

// [BATCH-5] dependsOn round-trips so a dependent serializes after its dep.
test("[BATCH-5] dependsOn serializes a dependent after its dependency", () => {
  const plan = planFromDecomposition(decomp([
    sub({ id: "a", allowedPaths: ["src/a/"] }),
    sub({ id: "b", allowedPaths: ["src/b/"], dependsOn: ["a"] }),
  ]));
  const w = plan.workers.find((x) => x.id === "b");
  assert.deepEqual(w!.dependsOn, ["a"]);
  // only "a" is runnable first (b depends on it).
  const batches = buildRunnableBatches(plan, { maxConcurrency: 2 });
  assert.deepEqual(batches[0].workerIds, ["a"], "the dependency runs before the dependent");
});
