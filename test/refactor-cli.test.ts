/**
 * Auto-refactor — headless CLI composition (DI fakes; no model/worktree/gh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import {
  runRefactorPlan,
  runRefactorAuto,
  runRefactorRun,
  runRefactorValidate,
  runRefactorPr,
  registerRefactorCommand,
} from "../src/cli/refactorCli.js";
import { runDelegateRun, runDelegateValidate, runDelegatePr } from "../src/cli/delegateCli.js";
import type { RepoStructure } from "../src/refactor/discovery.js";
import type { WorkerValidation } from "../src/delegate/types.js";

const structure = (areas: string[]): RepoStructure => ({
  root: "/r",
  areas: areas.map((area) => ({ area, files: [`${area}/x.ts`], testFiles: [`test/${area.split("/")[1]}.test.ts`], fanIn: 0, largeFiles: [], duplicateSymbols: [] })),
  indexEmpty: areas.length === 0,
});

const validation = (applyable: boolean): WorkerValidation =>
  ({ workerId: "w", status: applyable ? "passed" : "failed", applyable, failures: [], warnings: [], evidence: [], evaluatedAt: "t" }) as unknown as WorkerValidation;

test("[RC-0] run/validate/pr are the delegate leaves (re-exported identity)", () => {
  assert.equal(runRefactorRun, runDelegateRun);
  assert.equal(runRefactorValidate, runDelegateValidate);
  assert.equal(runRefactorPr, runDelegatePr);
});

test("[RC-1] runRefactorPlan discovers → maps → saves, returns plan id", async () => {
  let saved: { id: string } | null = null;
  const res = await runRefactorPlan("/r", {}, {
    discover: async () => structure(["src/auth", "src/db"]),
    savePlan: async (_root, plan) => { saved = plan; },
    checkNames: () => ["phase"],
  });
  assert.equal(res.exitCode, 0);
  assert.ok(res.planId && res.planId.startsWith("refactor-"));
  assert.ok(saved && saved!.id === res.planId);
});

test("[RC-1b] empty repo → exit 2, no plan; unknown --area → exit 2", async () => {
  const empty = await runRefactorPlan("/r", {}, { discover: async () => structure([]), savePlan: async () => {}, checkNames: () => [] });
  assert.equal(empty.exitCode, 2);
  assert.equal(empty.planId, null);

  const badArea = await runRefactorPlan("/r", { area: "nope" }, { discover: async () => structure(["src/auth"]), savePlan: async () => {}, checkNames: () => [] });
  assert.equal(badArea.exitCode, 2);
});

test("[RC-1c] --area filters to the one area", async () => {
  let saved: { workers: unknown[] } | null = null;
  const res = await runRefactorPlan("/r", { area: "auth" }, {
    discover: async () => structure(["src/auth", "src/db"]),
    savePlan: async (_r, plan) => { saved = plan; },
    checkNames: () => ["phase"],
  });
  assert.equal(res.exitCode, 0);
  assert.equal(saved!.workers.length, 1);
});

test("[RC-2] runRefactorAuto: applyable worker → PR collected", async () => {
  const calls: string[] = [];
  const res = await runRefactorAuto("/r", {}, {
    plan: async () => ({ exitCode: 0, planId: "refactor-1" }),
    run: async () => { calls.push("run"); return { exitCode: 0, result: null }; },
    loadPlan: async () => ({ id: "refactor-1", task: "t", createdAt: "t", status: "planned", workers: [{ id: "worker-1" }] as never, dependencies: [], globalChecks: [], riskNotes: [] }),
    validate: async () => validation(true),
    pr: async () => { calls.push("pr"); return { exitCode: 0, prUrl: "http://pr/1" }; },
  });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.prUrls, ["http://pr/1"]);
  assert.deepEqual(calls, ["run", "pr"]);
});

test("[RC-2b] non-applyable worker → NO PR, exit 1 (the autonomy gate)", async () => {
  let prCalled = false;
  const res = await runRefactorAuto("/r", {}, {
    plan: async () => ({ exitCode: 0, planId: "refactor-1" }),
    run: async () => ({ exitCode: 1, result: null }),
    loadPlan: async () => ({ id: "refactor-1", task: "t", createdAt: "t", status: "planned", workers: [{ id: "worker-1" }] as never, dependencies: [], globalChecks: [], riskNotes: [] }),
    validate: async () => validation(false),
    pr: async () => { prCalled = true; return { exitCode: 0, prUrl: "x" }; },
  });
  assert.equal(res.exitCode, 1);
  assert.deepEqual(res.prUrls, []);
  assert.equal(prCalled, false, "non-applyable worker must never open a PR");
});

test("[RC-2c] --no-pr stops after validation (no PRs even when applyable)", async () => {
  let prCalled = false;
  const res = await runRefactorAuto("/r", { noPr: true }, {
    plan: async () => ({ exitCode: 0, planId: "refactor-1" }),
    run: async () => ({ exitCode: 0, result: null }),
    loadPlan: async () => ({ id: "refactor-1", task: "t", createdAt: "t", status: "planned", workers: [{ id: "worker-1" }] as never, dependencies: [], globalChecks: [], riskNotes: [] }),
    validate: async () => validation(true),
    pr: async () => { prCalled = true; return { exitCode: 0, prUrl: "x" }; },
  });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.prUrls, []);
  assert.equal(prCalled, false);
});

test("[RC-3] registerRefactorCommand registers plan|run|validate|pr|auto", () => {
  const program = new Command();
  const refactor = registerRefactorCommand(program, { root: "/r" });
  const subs = refactor.commands.map((c) => c.name()).sort();
  assert.deepEqual(subs, ["auto", "plan", "pr", "run", "validate"]);
});
