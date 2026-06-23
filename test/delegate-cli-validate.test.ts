import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
// [DCV] red anchor on baseline: the module does not exist yet.
import {
  runDelegateValidate,
  runDelegateRun,
  runDelegateApply,
  runDelegatePlan,
  registerDelegateCommand,
} from "../src/cli/delegateCli.js";
import type { WorkerValidation } from "../src/delegate/types.js";

function fakeValidation(applyable: boolean): WorkerValidation {
  return {
    status: applyable ? "valid" : "invalid",
    applyable,
    evaluatedAt: "2026-06-23T00:00:00.000Z",
    failures: applyable ? [] : [{ code: "out_of_scope", message: "touched a forbidden path", source: "patch" }],
    warnings: [],
    evidence: [],
  };
}

// [DCV-1] all-workers mode: exit 0 only when EVERY worker is applyable.
test("[DCV-1] runDelegateValidate exits non-zero if any worker is not applyable", async () => {
  const plan = { id: "p1", workers: [{ id: "w1" }, { id: "w2" }] };
  const validations: Record<string, boolean> = { w1: true, w2: false };
  const res = await runDelegateValidate("/root", "p1", undefined, {}, {
    loadPlan: async () => plan as any,
    validate: async (_r, _p, wid) => fakeValidation(validations[wid]),
  });
  assert.equal(res.results.length, 2);
  assert.equal(res.exitCode, 1, "w2 is not applyable → non-zero");
});

// [DCV-2] single applyable worker → exit 0.
test("[DCV-2] runDelegateValidate exits 0 for a single applyable worker", async () => {
  const plan = { id: "p1", workers: [{ id: "w1" }, { id: "w2" }] };
  const res = await runDelegateValidate("/root", "p1", "w1", {}, {
    loadPlan: async () => plan as any,
    validate: async () => fakeValidation(true),
  });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, "w1");
  assert.equal(res.exitCode, 0);
});

// [DCV-3] missing plan → distinct non-zero exit, no validations.
test("[DCV-3] runDelegateValidate exits 2 when the plan is not found", async () => {
  const res = await runDelegateValidate("/root", "nope", undefined, {}, {
    loadPlan: async () => null,
    validate: async () => fakeValidation(true),
  });
  assert.equal(res.exitCode, 2);
  assert.equal(res.results.length, 0);
});

// [DCV-4] WIRED: registerDelegateCommand adds the headless subcommands to a
// commander program (anchors the CLI wiring; main.ts calls this).
test("[DCV-4] registerDelegateCommand registers validate/run/apply", () => {
  const program = new Command();
  registerDelegateCommand(program, { root: "/root" });
  const delegate = program.commands.find((c) => c.name() === "delegate");
  assert.ok(delegate, "delegate command registered");
  for (const sub of ["plan", "validate", "run", "apply"]) {
    assert.ok(delegate!.commands.find((c) => c.name() === sub), `delegate ${sub} registered`);
  }
});

// [DCV-5] run: exit 0 only when every ran worker passed and there are no conflicts.
test("[DCV-5] runDelegateRun exits non-zero on a failed worker or a conflict", async () => {
  const plan = { id: "p1", workers: [{ id: "w1" }] };
  const pass = await runDelegateRun("/root", "p1", undefined, {}, {
    loadPlan: async () => plan as any,
    runRunnable: async () => ({ ran: [{ workerId: "w1", passed: true, changedFiles: ["src/a.ts"] }], skipped: [], conflicts: [] }),
  });
  assert.equal(pass.exitCode, 0);

  const fail = await runDelegateRun("/root", "p1", undefined, {}, {
    loadPlan: async () => plan as any,
    runRunnable: async () => ({ ran: [{ workerId: "w1", passed: false, changedFiles: [] }], skipped: [], conflicts: [] }),
  });
  assert.equal(fail.exitCode, 1);
});

// [DCV-6] run: unknown plan → exit 2.
test("[DCV-6] runDelegateRun exits 2 when the plan is missing", async () => {
  const res = await runDelegateRun("/root", "nope", undefined, {}, {
    loadPlan: async () => null,
    runRunnable: async () => ({ ran: [], skipped: [], conflicts: [] }),
  });
  assert.equal(res.exitCode, 2);
});

// [DCV-8] plan: builds a plan from a task and persists it, returning its id.
test("[DCV-8] runDelegatePlan builds + saves a plan and returns its id", async () => {
  let saved: any = null;
  const res = await runDelegatePlan("/root", "fix the parser", {}, {
    buildPlan: () => ({ id: "p-123", workers: [{ id: "w1" }] }) as any,
    savePlan: async (_root, plan) => { saved = plan; },
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.planId, "p-123");
  assert.equal(saved?.id, "p-123", "savePlan received the built plan");
});

// [DCV-9] plan: empty task → exit 2, nothing saved.
test("[DCV-9] runDelegatePlan rejects an empty task", async () => {
  let savedCount = 0;
  const res = await runDelegatePlan("/root", "   ", {}, {
    buildPlan: () => ({ id: "x", workers: [] }) as any,
    savePlan: async () => { savedCount++; },
  });
  assert.equal(res.exitCode, 2);
  assert.equal(savedCount, 0);
});

// [DCV-7] apply: exit 0 iff applyWorker reports ok.
test("[DCV-7] runDelegateApply maps applyWorker.ok to the exit code", async () => {
  const ok = await runDelegateApply("/root", "p1", "w1", {}, { apply: async () => ({ ok: true, message: "applied" }) });
  assert.equal(ok.exitCode, 0);
  const bad = await runDelegateApply("/root", "p1", "w1", {}, { apply: async () => ({ ok: false, message: "not applyable" }) });
  assert.equal(bad.exitCode, 1);
});
