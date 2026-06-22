/**
 * Phase 9P — Adversarial tests for the Delegation Autopilot.
 *
 * The autopilot is the only autonomous parent-side loop, so it is exactly the
 * surface where a weak model (or a bug) could quietly apply an unvalidated
 * patch, recurse into nested delegation, hide a failed final check, or leak a
 * secret into an artifact. Every test below exercises `runAutopilot` with
 * FAKE seams (no live model, no real subprocess, no network) and on-disk temp
 * fixtures, and pins one safety invariant non-vacuously: most fakes RECORD that
 * the dangerous seam (applyWorker / runWorkers) was or was NOT called.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runAutopilot,
  readAutopilotArtifact,
  type AutopilotInput,
  type AutopilotSeams,
} from "../../src/delegate/autopilot.js";
import { loadPlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerTask, WorkerValidation } from "../../src/delegate/types.js";
import type { OrchestrationResult } from "../../src/delegate/orchestrator.js";
import type { ApplyResult } from "../../src/delegate/apply.js";
import type { DelegateAutopilotConfig } from "../../src/config/config.js";
import { DEFAULT_DELEGATE_AUTOPILOT } from "../../src/config/config.js";

/* ------------------------------------------------------------------ */
/*  Fixtures & fakes                                                   */
/* ------------------------------------------------------------------ */

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "autopilot-"));
}

function cfg(over: Partial<DelegateAutopilotConfig> = {}): DelegateAutopilotConfig {
  return {
    enabled: true,
    maxRounds: 3,
    maxWorkers: 5,
    maxConcurrency: 2,
    acceptanceFirst: false,
    autoApply: false,
    stopOnConflict: true,
    stopOnQualityWarning: false,
    ...over,
  };
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

/** A buildPlan seam that returns a fixed plan (deep-cloned each call so the
 * autopilot mutating worker statuses cannot leak across the loop's view). */
function fixedPlan(workers: WorkerTask[], over: Partial<DelegationPlan> = {}): AutopilotSeams["buildPlan"] {
  return () => makePlan(workers.map((w) => ({ ...w })), over);
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

interface RunCall {
  workerIds: string[];
}

/** Records every runWorkers call and returns a scripted OrchestrationResult. */
function fakeRunWorkers(
  script: (call: { plan: DelegationPlan; round: number }) => OrchestrationResult,
  log: RunCall[],
): NonNullable<AutopilotSeams["runWorkers"]> {
  let round = 0;
  return (async (plan: DelegationPlan) => {
    round += 1;
    const runnable = plan.workers.filter(
      (w) => (w.status === "planned" || w.status === "failed") &&
        w.dependsOn.every((d) => plan.workers.find((x) => x.id === d)?.status === "applied"),
    );
    log.push({ workerIds: runnable.map((w) => w.id) });
    return script({ plan, round });
  }) as NonNullable<AutopilotSeams["runWorkers"]>;
}

function ranOk(ids: string[]): OrchestrationResult {
  return { ran: ids.map((id) => ({ workerId: id, passed: true, changedFiles: [`src/${id}.ts`] })), skipped: [], conflicts: [] };
}

function baseInput(root: string, over: Partial<AutopilotInput> = {}): AutopilotInput {
  return {
    realRoot: root,
    task: "do the thing",
    checks: { phase: { command: "true" } },
    config: cfg(),
    signal: new AbortController().signal,
    ...over,
  };
}

/* ================================================================== */
/*  1. Default config is OFF                                          */
/* ================================================================== */

test("default autopilot config is OFF (and conservative)", () => {
  assert.equal(DEFAULT_DELEGATE_AUTOPILOT.enabled, false);
  assert.equal(DEFAULT_DELEGATE_AUTOPILOT.autoApply, false);
  assert.equal(DEFAULT_DELEGATE_AUTOPILOT.stopOnConflict, true);
});

test("runAutopilot refuses when config.enabled=false (no workers run)", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: false }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
        },
      }),
    );
    assert.equal(r.status, "blocked");
    assert.match(r.summary, /not enabled/i);
    assert.equal(runLog.length, 0, "no workers may run when autopilot is disabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  2. Dry-run: plan built, NO workers                               */
/* ================================================================== */

test("dry-run creates a plan and runs NO workers", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const applyLog: string[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        dryRun: true,
        config: cfg({ enabled: false }), // dry-run must work even when disabled
        seams: {
          buildPlan: fixedPlan([worker(), worker({ id: "w2" })]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
          applyWorker: (async () => {
            applyLog.push("apply");
            return { ok: true, message: "" } as ApplyResult;
          }) as NonNullable<AutopilotSeams["applyWorker"]>,
        },
      }),
    );
    assert.equal(r.status, "dry_run");
    assert.ok(r.plan, "dry-run returns the built plan");
    assert.equal(r.plan!.workers.length, 2);
    assert.equal(runLog.length, 0, "dry-run must not run workers");
    assert.equal(applyLog.length, 0, "dry-run must not apply");

    // Plan persisted before any execution.
    const saved = await loadPlan(root, r.planId);
    assert.ok(saved, "plan must be saved on disk in dry-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  3. maxWorkers cap enforced                                       */
/* ================================================================== */

test("maxWorkers cap is enforced (plan trimmed to the cap)", async () => {
  const root = await tmpRoot();
  try {
    const six = [1, 2, 3, 4, 5, 6].map((n) => worker({ id: `w${n}`, allowedPaths: [`src/w${n}.ts`] }));
    const r = await runAutopilot(
      baseInput(root, {
        dryRun: true,
        config: cfg({ enabled: true, maxWorkers: 4 }),
        seams: { buildPlan: fixedPlan(six) },
      }),
    );
    assert.equal(r.plan!.workers.length, 4, "plan must be capped to maxWorkers");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  4. maxRounds prevents infinite retry                             */
/* ================================================================== */

test("maxRounds caps the number of orchestration rounds (no infinite retry)", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    // Worker always 'runs' but never becomes applyable → would loop forever
    // if maxRounds were not enforced. Each round the worker is reset to failed
    // so it stays runnable.
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([worker()]),
      runWorkers: fakeRunWorkers(({ plan }) => {
        // keep the worker runnable across rounds (failed is runnable)
        const w = plan.workers.find((x) => x.id === "w1");
        if (w) w.status = "failed";
        return { ran: [{ workerId: "w1", passed: false, changedFiles: [] }], skipped: [], conflicts: [] };
      }, runLog),
    };
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, maxRounds: 2, autoApply: true, stopOnConflict: false }),
        seams,
      }),
    );
    assert.ok(runLog.length <= 2, `must not exceed maxRounds; ran ${runLog.length} rounds`);
    assert.ok(r.rounds.length <= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  5. Dependency order respected; independents batched              */
/* ================================================================== */

test("dependency order respected: dependent only becomes runnable after its dep is applied", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const applyLog: string[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/w1.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/w2.ts"], dependsOn: ["w1"] });

    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([w1, w2], { dependencies: [{ before: "w1", after: "w2", reason: "seq" }] }),
      runWorkers: fakeRunWorkers(({ plan }) => {
        const runnable = plan.workers.filter(
          (w) => (w.status === "planned" || w.status === "failed") &&
            w.dependsOn.every((d) => plan.workers.find((x) => x.id === d)?.status === "applied"),
        );
        return ranOk(runnable.map((w) => w.id));
      }, runLog),
      validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_r: string, _p: string, id: string) => {
        applyLog.push(id);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };

    await runAutopilot(
      baseInput(root, { config: cfg({ enabled: true, autoApply: true, stopOnConflict: false }), seams }),
    );

    // Round 1 must only see w1 runnable (w2 depends on it, not yet applied).
    assert.deepEqual(runLog[0]?.workerIds, ["w1"], "first round runs only the independent worker");
    // w2 must be applied AFTER w1.
    assert.deepEqual(applyLog, ["w1", "w2"], "apply must follow dependency order");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent workers are batched into one round", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/w1.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/w2.ts"] });
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([w1, w2]),
      runWorkers: fakeRunWorkers(({ plan }) => {
        const runnable = plan.workers.filter((w) => w.status === "planned");
        return ranOk(runnable.map((w) => w.id));
      }, runLog),
      validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async () => ({ ok: true, message: "" } as ApplyResult)) as NonNullable<AutopilotSeams["applyWorker"]>,
    };
    await runAutopilot(
      baseInput(root, { config: cfg({ enabled: true, autoApply: true, stopOnConflict: false }), seams }),
    );
    assert.deepEqual(runLog[0]?.workerIds.sort(), ["w1", "w2"], "independent workers batched in one round");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  6. Nested delegation stays REFUSED                               */
/* ================================================================== */

test("nested delegation refused: runAutopilot inside a delegated worker (depth>0) runs nothing", async () => {
  const root = await tmpRoot();
  const prev = process.env.DEEPCODER_DELEGATE_DEPTH;
  process.env.DEEPCODER_DELEGATE_DEPTH = "1";
  try {
    const runLog: RunCall[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: true }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
        },
      }),
    );
    assert.equal(r.status, "blocked");
    assert.match(r.summary, /nest|delegat|depth/i);
    assert.equal(runLog.length, 0, "a delegated worker must not spawn its own worker tree");
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_DELEGATE_DEPTH;
    else process.env.DEEPCODER_DELEGATE_DEPTH = prev;
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  7. Failed validation blocks apply                                */
/* ================================================================== */

test("failed validation blocks apply (applyWorker never called)", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const runLog: RunCall[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: true, stopOnConflict: false }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
          validateWorker: (async () =>
            validation({
              status: "invalid",
              applyable: false,
              failures: [{ code: "completeness_failed", message: "missing deliverable", source: "completeness" }],
            })) as NonNullable<AutopilotSeams["validateWorker"]>,
          applyWorker: (async (_r: string, _p: string, id: string) => {
            applyLog.push(id);
            return { ok: true, message: "" } as ApplyResult;
          }) as NonNullable<AutopilotSeams["applyWorker"]>,
        },
      }),
    );
    assert.equal(applyLog.length, 0, "a worker with failed validation must NEVER be applied");
    assert.ok(r.blockedWorkers.includes("w1"));
    assert.ok(!r.appliedWorkers.includes("w1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  8. autoApply=false NEVER mutates the real repo                   */
/* ================================================================== */

test("autoApply=false never calls applyWorker even for fully-valid workers", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const runLog: RunCall[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: false }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
          validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
          applyWorker: (async (_r: string, _p: string, id: string) => {
            applyLog.push(id);
            return { ok: true, message: "" } as ApplyResult;
          }) as NonNullable<AutopilotSeams["applyWorker"]>,
        },
      }),
    );
    assert.equal(applyLog.length, 0, "autoApply=false must never apply");
    assert.equal(r.status, "blocked");
    assert.ok((r.nextSteps ?? "").includes("/delegate apply"), "must surface safe apply commands");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/*  9. autoApply=true applies ONLY fully-valid workers, in dep order */
/* ================================================================== */

test("autoApply=true applies only fully-valid workers (valid w1 applied, invalid w2 blocked)", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const runLog: RunCall[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/w1.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/w2.ts"] });
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: true, stopOnConflict: false }),
        seams: {
          buildPlan: fixedPlan([w1, w2]),
          runWorkers: fakeRunWorkers(({ plan }) => {
            const runnable = plan.workers.filter((w) => w.status === "planned");
            return ranOk(runnable.map((w) => w.id));
          }, runLog),
          validateWorker: (async (_r: string, _p: string, id: string) =>
            id === "w2" ? validation({ status: "invalid", applyable: false }) : validation()) as NonNullable<
            AutopilotSeams["validateWorker"]
          >,
          applyWorker: (async (_r: string, _p: string, id: string) => {
            applyLog.push(id);
            return { ok: true, message: "" } as ApplyResult;
          }) as NonNullable<AutopilotSeams["applyWorker"]>,
        },
      }),
    );
    assert.deepEqual(applyLog, ["w1"], "only the fully-valid worker is applied");
    assert.ok(r.appliedWorkers.includes("w1"));
    assert.ok(r.blockedWorkers.includes("w2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 10. Conflict stops autopilot with status blocked, no resolution   */
/* ================================================================== */

test("conflict stops autopilot (status blocked, applyWorker never called)", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const runLog: RunCall[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/shared.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/shared.ts"] });
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: true, stopOnConflict: true }),
        seams: {
          buildPlan: fixedPlan([w1, w2]),
          runWorkers: fakeRunWorkers(
            () => ({
              ran: [
                { workerId: "w1", passed: true, changedFiles: ["src/shared.ts"] },
                { workerId: "w2", passed: true, changedFiles: ["src/shared.ts"] },
              ],
              skipped: [],
              conflicts: [{ a: "w1", b: "w2", paths: ["src/shared.ts"] }],
            }),
            runLog,
          ),
          validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
          applyWorker: (async (_r: string, _p: string, id: string) => {
            applyLog.push(id);
            return { ok: true, message: "" } as ApplyResult;
          }) as NonNullable<AutopilotSeams["applyWorker"]>,
        },
      }),
    );
    assert.equal(r.status, "blocked", "a conflict must block the autopilot");
    assert.match(r.summary, /conflict/i);
    assert.equal(applyLog.length, 0, "no automatic resolution: nothing may be applied on conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 11. Final check failure -> reported as failed, not hidden         */
/* ================================================================== */

test("final check failure is reported as failed, not hidden", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const r = await runAutopilot(
      baseInput(root, {
        config: cfg({ enabled: true, autoApply: true, stopOnConflict: false }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
          validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
          applyWorker: (async () => ({ ok: true, message: "" } as ApplyResult)) as NonNullable<
            AutopilotSeams["applyWorker"]
          >,
          // The final check FAILS (non-zero exit). It must surface, not be swallowed.
          runCheck: (async (name: string) => ({
            id: "run-x",
            name,
            command: "true",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            exitCode: 1,
            timedOut: false,
            truncated: false,
            logPath: ".deepcoder/runs/run-x.log",
          })) as NonNullable<AutopilotSeams["runCheck"]>,
        },
      }),
    );
    assert.equal(r.finalCheckPassed, false, "a failing final check must be recorded as failed");
    assert.equal(r.status, "failed", "the run must surface as failed, not completed");
    assert.match(r.summary, /FAIL/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 12. Artifacts redacted (no secrets) and bounded                   */
/* ================================================================== */

test("artifact redacts secrets in the task and is bounded", async () => {
  const root = await tmpRoot();
  try {
    const runLog: RunCall[] = [];
    const secret = "sk-ant-api03-DEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEFdeadbeef0001";
    const r = await runAutopilot(
      baseInput(root, {
        task: `implement using key ${secret} now`,
        dryRun: true,
        config: cfg({ enabled: true }),
        seams: {
          buildPlan: fixedPlan([worker()]),
          runWorkers: fakeRunWorkers(() => ranOk(["w1"]), runLog),
        },
      }),
    );
    const artifact = await readAutopilotArtifact(root, r.planId);
    assert.ok(artifact, "artifact must be written");
    assert.ok(!artifact!.task.includes(secret), "the raw secret must NOT appear in the artifact");

    // Also confirm the on-disk JSON is secret-free and bounded.
    const raw = await readFile(
      path.join(root, ".deepcoder", "delegations", r.planId, "autopilot.json"),
      "utf8",
    );
    assert.ok(!raw.includes(secret), "no secret may be written to disk");
    assert.ok(raw.length < 1_000_000, "artifact must be bounded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
