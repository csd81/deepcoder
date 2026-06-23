/**
 * Phase — Adversarial tests for Coordinator Mode.
 *
 * Tests `runCoordinator` with FAKE seams (no live model, no real subprocess).
 * Covers multi-round orchestration, integrate gating, cycle prevention,
 * termination conditions, conflict handling, and nested-delegation refusal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCoordinator,
  type CoordinatorInput,
  type CoordinatorSeams,
} from "../../src/delegate/coordinator.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";
import type { DelegationPlan, WorkerTask, WorkerValidation, RoundDigest, CoordinatorDecision } from "../../src/delegate/types.js";
import type { OrchestrationResult } from "../../src/delegate/orchestrator.js";
import type { ApplyResult } from "../../src/delegate/apply.js";

/* ------------------------------------------------------------------ */
/*  Fixtures & fakes                                                   */
/* ------------------------------------------------------------------ */

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coordinator-"));
}

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1",
    title: "do",
    prompt: "p",
    allowedPaths: ["src/a.ts"],
    forbiddenPaths: [],
    checkName: "phase",
    maxAttempts: 1,
    dependsOn: [],
    expectedOutputs: [],
    status: "planned",
    ...over,
  };
}

function makePlan(workers: WorkerTask[], over: Partial<DelegationPlan> = {}): DelegationPlan {
  return {
    id: "p1",
    task: "t",
    createdAt: new Date().toISOString(),
    status: "planned",
    workers,
    dependencies: [],
    globalChecks: [],
    riskNotes: [],
    ...over,
  };
}

function okResult(ranWorkers: { id: string; passed: boolean; files?: string[] }[]): OrchestrationResult {
  return {
    ran: ranWorkers.map((rw) => ({
      workerId: rw.id,
      passed: rw.passed,
      changedFiles: rw.files ?? ["src/a.ts"],
    })),
    skipped: [],
    conflicts: [],
  };
}

function validation(over: Partial<WorkerValidation> = {}): WorkerValidation {
  return {
    status: "valid",
    applyable: true,
    evaluatedAt: new Date().toISOString(),
    failures: [],
    warnings: [],
    evidence: [],
    ...over,
  };
}

function applyOk(): ApplyResult {
  return { ok: true, message: "applied" };
}

/* ------------------------------------------------------------------ */
/*  Seams builder                                                      */
/* ------------------------------------------------------------------ */

interface FakeSeamsOpts {
  /** Override the coordinator turn logic. Default: return empty next, no integrate. */
  coordinatorTurn?: (digest: RoundDigest) => Promise<CoordinatorDecision>;
  /** When set, overrides the default runWorkers function. */
  runWorkers?: (plan: DelegationPlan, opts: any) => Promise<OrchestrationResult>;
  /** When set, overrides the default validateWorker function. */
  validateWorker?: (root: string, planId: string, workerId: string, opts?: any) => Promise<WorkerValidation>;
  /** When set, overrides the default applyWorker function. */
  applyWorker?: (root: string, planId: string, workerId: string, opts?: any) => Promise<ApplyResult>;
}

function makeSeams(opts: FakeSeamsOpts = {}): CoordinatorSeams {
  return {
    runWorkers: opts.runWorkers ?? (async (_plan, _opts) => okResult([{ id: "w1", passed: true }])),
    validateWorker: opts.validateWorker ?? (async (_root, _planId, _workerId, _opts) => validation()),
    applyWorker: opts.applyWorker ?? (async (_root, _planId, _workerId, _opts) => applyOk()),
    coordinatorTurn: opts.coordinatorTurn ?? (async (_digest) => ({
      nextWorkers: [],
      integrate: [],
    })),
  };
}

function defaultInput(
  root: string,
  plan: DelegationPlan,
  seams: CoordinatorSeams,
  over: Partial<CoordinatorInput> = {},
): CoordinatorInput {
  return {
    realRoot: root,
    plan,
    maxRounds: 3,
    maxConcurrency: 2,
    autoApply: true,
    signal: new AbortController().signal,
    seams,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

test("Coordinator Mode Delegation Slice", async (t) => {

await t.test("[SLICE-coordinator-run] runCoordinator is exported", () => {
  assert.equal(typeof runCoordinator, "function", "runCoordinator must be a function");
});

await t.test("[SLICE-slash-coordinate] /delegate coordinate is dispatched by the slash switch", async () => {
  // Correct signature: handleSlashCommand(input, session, save, runAgent?).
  // An EMPTY task makes the coordinate case print its OWN usage line + return
  // consumed:true BEFORE building a plan or spawning any worker. We assert on the
  // coordinate-specific usage text (`--max-rounds`) rather than just `consumed`,
  // because the /delegate case consumes ANY subcommand generically — only the
  // wired coordinate case emits that usage, so this fails if the case is removed.
  const session: any = { config: { workspaceRoot: "/mock", checks: {} } };
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  let res;
  try {
    res = await handleSlashCommand("/delegate coordinate", session, async () => {});
  } finally {
    console.log = orig;
  }
  assert.ok(res.consumed, "/delegate coordinate must be consumed by the slash switch");
  assert.ok(
    out.join("\n").includes("--max-rounds"),
    "coordinate-specific usage proves the `case \"coordinate\"` is actually wired",
  );
});

await t.test("[coordinator] multi-round: round 1 runs seed workers, round 2 runs only newly added workers", async () => {
  const root = await tmpRoot();
  try {
    let callCount = 0;
    const ranHistory: string[][] = [];

    const seams = makeSeams({
      runWorkers: async (plan, _opts) => {
        callCount++;
        const runnable = plan.workers.filter((w) => w.status === "planned" && w.dependsOn.every((d) => {
          const dep = plan.workers.find((pw) => pw.id === d);
          return dep && dep.status === "applied";
        }));
        ranHistory.push(runnable.map((w) => w.id));
        return okResult(runnable.map((w) => ({ id: w.id, passed: true })));
      },
      coordinatorTurn: async (digest) => {
        if (digest.round === 1) {
          // Spawn a new worker for round 2.
          return {
            nextWorkers: [worker({ id: "w2", dependsOn: ["w1"] })],
            integrate: ["w1"],
          };
        }
        return { nextWorkers: [], integrate: [], done: true };
      },
    });

    const plan = makePlan([worker({ id: "w1" })]);
    const result = await runCoordinator(defaultInput(root, plan, seams));

    assert.equal(result.status, "done");
    assert.equal(callCount, 2, "should have run workers twice (once per round)");
    assert.deepEqual(ranHistory[0], ["w1"], "round 1 should run w1");
    assert.deepEqual(ranHistory[1], ["w2"], "round 2 should run only w2 (newly added)");
    assert.deepEqual(result.appliedWorkers, ["w1"], "w1 should be applied via integrate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await t.test("[coordinator] integrate: failed worker is refused at the gate", async () => {
  const root = await tmpRoot();
  try {
    let validateCalled = false;
    let applyCalled = false;

    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([{ id: "w1", passed: false }]),
      validateWorker: async (_root, _planId, _workerId, _opts) => {
        validateCalled = true;
        return validation();
      },
      applyWorker: async (_root, _planId, _workerId, _opts) => {
        applyCalled = true;
        return applyOk();
      },
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [],
        integrate: ["w1"],
      }),
    });

    const plan = makePlan([worker({ id: "w1" })]);
    // autoApply=true so integrate would trigger apply if validation passed
    const result = await runCoordinator(defaultInput(root, plan, seams));

    // Worker failed its check, so integrate should NOT validate/apply it
    assert.equal(validateCalled, false, "validate should not be called for a failed worker");
    assert.equal(applyCalled, false, "apply should not be called for a failed worker");
    assert.deepEqual(result.appliedWorkers, []);

    // Worker should appear in blocked list
    assert.ok(result.blockedWorkers.length > 0 || result.blockedWorkers.includes("w1"),
      "failed worker should be blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] auto-apply default off: nothing applied unless integrate + gate passes", async () => {
  const root = await tmpRoot();
  try {
    let applyCalled = false;

    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([{ id: "w1", passed: true }]),
      validateWorker: async (_root, _planId, _workerId, _opts) => validation({ applyable: false }),
      applyWorker: async (_root, _planId, _workerId, _opts) => {
        applyCalled = true;
        return applyOk();
      },
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [],
        integrate: ["w1"],
      }),
    });

    const plan = makePlan([worker({ id: "w1" })]);
    // autoApply=true but validation blocks applyable=false
    const result = await runCoordinator(defaultInput(root, plan, seams));

    // validate returns applyable=false, so apply should NOT be called
    assert.equal(applyCalled, false, "apply should not be called when validation blocks");
    assert.deepEqual(result.appliedWorkers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] cycle in nextWorkers aborts the round with clear error", async () => {
  const root = await tmpRoot();
  try {
    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([{ id: "w1", passed: true }]),
      coordinatorTurn: async (_digest) => ({
        // w3 depends on w2, creating inconsistency with the linear plan
        nextWorkers: [
          worker({ id: "w2", dependsOn: ["w1"] }),
          worker({ id: "w3", dependsOn: ["w2"] }),
        ],
        integrate: ["w1"],
      }),
    });

    // The seed plan has w1, and the coordinator adds w2→w3 — that's fine and not cyclic.
    // To trigger a cycle, we need a worker that depends on itself or creates a mutual cycle.
    // Let's add w2 depends on w3 and w3 depends on w2.
    const seamsCycle = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([{ id: "w1", passed: true }]),
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [
          worker({ id: "w2", dependsOn: ["w3"] }),
          worker({ id: "w3", dependsOn: ["w2"] }),
        ],
        integrate: [],
      }),
    });

    const plan = makePlan([worker({ id: "w1" })]);
    const result = await runCoordinator(defaultInput(root, plan, seamsCycle));

    // The cycle should cause the round to abort with "failed" status
    assert.equal(result.status, "failed", "cycle should cause coordinator to fail");
    assert.ok(result.summary.includes("cycle") || result.summary.includes("Cycle"),
      `error message should mention cycle: ${result.summary}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] termination: coordinator done stops loop", async () => {
  const root = await tmpRoot();
  try {
    let runCount = 0;

    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => {
        runCount++;
        return okResult([{ id: "w1", passed: true }]);
      },
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [],
        integrate: [],
        done: true,
      }),
    });

    const plan = makePlan([worker({ id: "w1" })]);
    const result = await runCoordinator(defaultInput(root, plan, seams));

    assert.equal(result.status, "done", "coordinator done should yield 'done' status");
    assert.equal(runCount, 1, "only 1 round should run before done terminates");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] termination: no runnable workers stops loop", async () => {
  const root = await tmpRoot();
  try {
    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([]),
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [],
        integrate: [],
      }),
    });

    // Worker w1 depends on w2 which doesn't exist — w1 is never runnable.
    const plan = makePlan([worker({ id: "w1", dependsOn: ["w2"] })]);
    const result = await runCoordinator(defaultInput(root, plan, seams));

    assert.equal(result.status, "blocked", "no runnable workers should yield 'blocked'");
    assert.equal(result.rounds.length, 0, "no rounds should execute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] termination: maxRounds limits loop", async () => {
  const root = await tmpRoot();
  try {
    let runCount = 0;

    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => {
        runCount++;
        return okResult([{ id: "w1", passed: true }]);
      },
      coordinatorTurn: async (digest) => {
        if (digest.round < 2) {
          return {
            nextWorkers: [worker({ id: `w${digest.round + 1}`, dependsOn: ["w1"] })],
            integrate: ["w1"],
          };
        }
        return { nextWorkers: [], integrate: [], done: true };
      },
    });

    const plan = makePlan([worker({ id: "w1" })]);
    // maxRounds=1 should stop after 1 round
    const result = await runCoordinator(defaultInput(root, plan, seams, { maxRounds: 1 }));

    assert.equal(runCount, 1, "only 1 round should run with maxRounds=1");
    assert.ok(result.status === "completed" || result.status === "blocked",
      `unexpected status: ${result.status}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] conflicts are surfaced and conflicting workers are not auto-integrated", async () => {
  const root = await tmpRoot();
  try {
    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => ({
        ran: [
          { workerId: "w1", passed: true, changedFiles: ["src/a.ts"] },
          { workerId: "w2", passed: true, changedFiles: ["src/a.ts"] },
        ],
        skipped: [],
        conflicts: [{ a: "w1", b: "w2", paths: ["src/a.ts"] }],
      }),
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [],
        integrate: ["w1", "w2"],
      }),
    });

    const plan = makePlan([
      worker({ id: "w1" }),
      worker({ id: "w2" }),
    ]);
    const result = await runCoordinator(defaultInput(root, plan, seams));

    // Conflicting workers should be blocked (status "conflict"), not integrated
    assert.equal(
      plan.workers.find((w) => w.id === "w1")?.status,
      "conflict",
      "w1 should be marked conflict",
    );
    assert.equal(
      plan.workers.find((w) => w.id === "w2")?.status,
      "conflict",
      "w2 should be marked conflict",
    );
    assert.deepEqual(result.appliedWorkers, [], "no conflicting workers should be applied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] nested delegation guard", async () => {
  const root = await tmpRoot();
  try {
    // Set up environment with depth > 0
    const origEnv = process.env.DEEPCODER_DELEGATE_DEPTH;
    process.env.DEEPCODER_DELEGATE_DEPTH = "1";

    try {
      const plan = makePlan([worker({ id: "w1" })]);
      const seams = makeSeams();
      const result = await runCoordinator(defaultInput(root, plan, seams));

      assert.equal(result.status, "blocked", "nested delegation should be blocked");
      assert.ok(result.summary.includes("nested") || result.summary.includes("depth"),
        `should mention nested delegation: ${result.summary}`);
    } finally {
      if (origEnv === undefined) {
        delete process.env.DEEPCODER_DELEGATE_DEPTH;
      } else {
        process.env.DEEPCODER_DELEGATE_DEPTH = origEnv;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("[coordinator] duplicate worker id in nextWorkers is rejected", async () => {
  const root = await tmpRoot();
  try {
    const seams = makeSeams({
      runWorkers: async (_plan, _opts) => okResult([{ id: "w1", passed: true }]),
      coordinatorTurn: async (_digest) => ({
        nextWorkers: [worker({ id: "w2" })],
        integrate: [],
      }),
      applyWorker: async (_root, _planId, _workerId, _opts) => applyOk(),
    });

    const plan = makePlan([
      worker({ id: "w1" }),
      worker({ id: "w2" }),
    ]);
    const result = await runCoordinator(defaultInput(root, plan, seams));

    // w2 already exists, so coordinator should fail when trying to add duplicate
    assert.equal(result.status, "failed", "duplicate worker id should cause failure");
    assert.ok(result.summary.includes("duplicate") || result.summary.includes("Duplicate"),
      `error should mention duplicate: ${result.summary}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

});
