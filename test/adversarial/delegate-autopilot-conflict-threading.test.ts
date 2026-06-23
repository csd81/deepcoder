/**
 * Audit fix (MEDIUM): the autopilot's validation-time conflict gate was inert
 * because each worker was validated with `alreadyChangedPaths: []` hard-coded.
 * A later worker in the same round that touches a path a peer ALREADY APPLIED
 * could thus slip past validation (the overlap → conflict gate never fired).
 *
 * These tests pin the fix: paths changed by previously-applied workers in the
 * SAME round are threaded into each subsequent worker's validation as
 * `alreadyChangedPaths`. Fake seams only — no live model, no real subprocess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runAutopilot,
  type AutopilotInput,
  type AutopilotSeams,
} from "../../src/delegate/autopilot.js";
import type { DelegationPlan, WorkerTask, WorkerValidation } from "../../src/delegate/types.js";
import type { OrchestrationResult } from "../../src/delegate/orchestrator.js";
import type { ApplyResult } from "../../src/delegate/apply.js";
import type { DelegateAutopilotConfig } from "../../src/config/config.js";

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "autopilot-conflict-"));
}

function cfg(over: Partial<DelegateAutopilotConfig> = {}): DelegateAutopilotConfig {
  return {
    enabled: true,
    maxRounds: 3,
    maxWorkers: 5,
    maxConcurrency: 2,
    acceptanceFirst: false,
    autoApply: true,
    stopOnConflict: false,
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

function makePlan(workers: WorkerTask[]): DelegationPlan {
  return {
    id: "p1",
    task: "t",
    createdAt: new Date().toISOString(),
    status: "planned",
    workers,
    dependencies: [],
    globalChecks: [],
    riskNotes: [],
  };
}

function fixedPlan(workers: WorkerTask[]): NonNullable<AutopilotSeams["buildPlan"]> {
  return (() => makePlan(workers.map((w) => ({ ...w })))) as NonNullable<AutopilotSeams["buildPlan"]>;
}

/** A runWorkers seam that runs only the workers currently runnable (status
 * planned/failed with deps applied), mirroring the real orchestrator so an
 * already-applied worker is never re-run across rounds. */
function runRunnable(
  changedFor: Record<string, string[]>,
): NonNullable<AutopilotSeams["runWorkers"]> {
  return (async (plan: DelegationPlan) => {
    const runnable = plan.workers.filter(
      (w) =>
        (w.status === "planned" || w.status === "failed") &&
        w.dependsOn.every((d) => plan.workers.find((x) => x.id === d)?.status === "applied"),
    );
    return {
      ran: runnable.map((w) => ({ workerId: w.id, passed: true, changedFiles: changedFor[w.id] ?? [] })),
      skipped: [],
      conflicts: [],
    } as OrchestrationResult;
  }) as NonNullable<AutopilotSeams["runWorkers"]>;
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

/* ------------------------------------------------------------------ */

test("autopilot threads applied workers' paths into the next worker's validation", async () => {
  const root = await tmpRoot();
  try {
    // Two independent workers in the same round; the orchestrator says both
    // changed src/shared.ts. w1 applies first.
    const validateCalls: { workerId: string; alreadyChangedPaths: string[] }[] = [];
    const applyLog: string[] = [];

    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([
        worker({ id: "w1", allowedPaths: ["src/shared.ts"] }),
        worker({ id: "w2", allowedPaths: ["src/shared.ts"] }),
      ]),
      runWorkers: runRunnable({ w1: ["src/shared.ts"], w2: ["src/shared.ts"] }),
      validateWorker: (async (
        _root: string,
        _planId: string,
        workerId: string,
        opts?: { alreadyChangedPaths?: string[] },
      ) => {
        validateCalls.push({ workerId, alreadyChangedPaths: opts?.alreadyChangedPaths ?? [] });
        return validation();
      }) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_root: string, _planId: string, workerId: string) => {
        applyLog.push(workerId);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };

    await runAutopilot(baseInput(root, { config: cfg({ maxRounds: 1 }), seams }));

    const w1 = validateCalls.find((c) => c.workerId === "w1");
    const w2 = validateCalls.find((c) => c.workerId === "w2");
    assert.ok(w1, "w1 was validated");
    assert.ok(w2, "w2 was validated");
    // w1 is validated first — nothing applied yet.
    assert.deepEqual(w1!.alreadyChangedPaths, [], "first worker sees an empty already-changed set");
    // After w1 applies (src/shared.ts), w2's validation must see that path so
    // the validation-time conflict gate can fire. This is the whole fix — it
    // was hard-coded to [] before.
    assert.ok(
      w2!.alreadyChangedPaths.includes("src/shared.ts"),
      "second worker must see the path applied by the first: " + JSON.stringify(w2!.alreadyChangedPaths),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker whose validation returns the overlap conflict is blocked, not applied", async () => {
  const root = await tmpRoot();
  try {
    // Real-ish: the validateWorker seam returns a conflict for w2 IF it was told
    // about an overlapping already-changed path (mirroring validateWorkerResult's
    // overlap→conflict gate, which only fires when alreadyChangedPaths is fed in).
    const applyLog: string[] = [];

    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([
        worker({ id: "w1", allowedPaths: ["src/shared.ts"] }),
        worker({ id: "w2", allowedPaths: ["src/shared.ts"] }),
      ]),
      runWorkers: runRunnable({ w1: ["src/shared.ts"], w2: ["src/shared.ts"] }),
      validateWorker: (async (
        _root: string,
        _planId: string,
        workerId: string,
        opts?: { alreadyChangedPaths?: string[] },
      ) => {
        const overlap = (opts?.alreadyChangedPaths ?? []).includes("src/shared.ts");
        if (overlap) {
          return validation({
            status: "conflict",
            applyable: false,
            failures: [{ code: "conflict", message: "overlap: src/shared.ts", source: "conflict" }],
          });
        }
        return validation();
      }) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_root: string, _planId: string, workerId: string) => {
        applyLog.push(workerId);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };

    const r = await runAutopilot(baseInput(root, { config: cfg({ maxRounds: 1 }), seams }));

    assert.deepEqual(applyLog, ["w1"], "only the first worker applies; the overlapping peer is blocked");
    assert.ok(r.blockedWorkers.includes("w2"), "w2 must be reported blocked: " + JSON.stringify(r.blockedWorkers));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
