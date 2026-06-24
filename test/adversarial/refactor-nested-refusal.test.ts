/**
 * Adversarial — a refactor worker can never itself fan out. runWorker refuses
 * when delegateDepth > 0 (WorkerRunError) BEFORE spawning anything, so a worker
 * that tried to launch `deepcoder refactor` recursively is stopped fail-closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runWorker, WorkerRunError } from "../../src/delegate/workerRunner.js";
import { refactorPlanToDelegationPlan } from "../../src/refactor/toRefactorWorkers.js";
import type { RefactorPlan } from "../../src/refactor/refactorPlan.js";

const PLAN: RefactorPlan = {
  areas: [{ area: "src/auth", files: ["src/auth/a.ts"], testFiles: ["test/auth.test.ts"], candidates: [], risk: "low", riskNotes: [] }],
  globalRiskNotes: [],
};

test("[ANR-1] runWorker at depth>0 throws WorkerRunError and never spawns", async () => {
  const plan = refactorPlanToDelegationPlan(PLAN, { checkNames: ["phase"], createdAt: "2026-06-24T00:00:00.000Z" });
  let spawned = false;

  await assert.rejects(
    () => runWorker({
      realRoot: "/r",
      plan,
      worker: plan.workers[0]!,
      signal: new AbortController().signal,
      mainEntry: "/r/src/cli/main.ts",
      provider: "deepseek",
      delegateDepth: 1, // we are already a worker
      parentEnv: { PATH: process.env.PATH ?? "" },
      spawnWorker: async () => { spawned = true; return { exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" }; },
    }),
    (err: unknown) => err instanceof WorkerRunError && /nested delegation refused/i.test((err as Error).message),
  );

  assert.equal(spawned, false, "must refuse BEFORE spawning a subprocess");
});
