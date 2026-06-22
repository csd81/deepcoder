/**
 * Phase 9P — Integration-style autopilot tests (no live model, no subprocess).
 *
 * These cover the "Integration/no-live-model" bullets of the plan: two disjoint
 * workers applied in order, a failing worker that blocks its dependents,
 * acceptance-first missing proof, and a patch conflict that blocks with no
 * automatic resolution. Fakes stand in for the runner/validator/apply seams;
 * fixtures live in a temp dir that is cleaned up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAutopilot, type AutopilotInput, type AutopilotSeams } from "../../src/delegate/autopilot.js";
import type { DelegationPlan, WorkerTask, WorkerValidation } from "../../src/delegate/types.js";
import type { OrchestrationResult } from "../../src/delegate/orchestrator.js";
import type { ApplyResult } from "../../src/delegate/apply.js";
import type { DelegateAutopilotConfig } from "../../src/config/config.js";

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "autopilot-int-"));
}

function cfg(over: Partial<DelegateAutopilotConfig> = {}): DelegateAutopilotConfig {
  return {
    enabled: true,
    maxRounds: 3,
    maxWorkers: 5,
    maxConcurrency: 2,
    acceptanceFirst: false,
    autoApply: true,
    stopOnConflict: true,
    stopOnQualityWarning: false,
    ...over,
  };
}

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "do", prompt: "p", allowedPaths: ["src/a.ts"], forbiddenPaths: [],
    checkName: "phase", maxAttempts: 1, dependsOn: [], expectedOutputs: [], status: "planned", ...over,
  };
}

function plan(workers: WorkerTask[], over: Partial<DelegationPlan> = {}): DelegationPlan {
  return {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers, dependencies: [], globalChecks: [], riskNotes: [], ...over,
  };
}

function fixedPlan(workers: WorkerTask[], over: Partial<DelegationPlan> = {}): AutopilotSeams["buildPlan"] {
  return () => plan(workers.map((w) => ({ ...w })), over);
}

function validation(over: Partial<WorkerValidation> = {}): WorkerValidation {
  return { status: "valid", applyable: true, evaluatedAt: new Date().toISOString(), failures: [], warnings: [], evidence: [], ...over };
}

function runnableOf(p: DelegationPlan): WorkerTask[] {
  return p.workers.filter(
    (w) => (w.status === "planned" || w.status === "failed") &&
      w.dependsOn.every((d) => p.workers.find((x) => x.id === d)?.status === "applied"),
  );
}

function input(root: string, over: Partial<AutopilotInput> = {}): AutopilotInput {
  return {
    realRoot: root, task: "two disjoint patches",
    checks: { phase: { command: "true" } },
    config: cfg(), signal: new AbortController().signal, ...over,
  };
}

/* ================================================================== */

test("integration: two disjoint workers → autopilot applies both in dependency order", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/w1.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/w2.ts"], dependsOn: ["w1"] });
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([w1, w2], { dependencies: [{ before: "w1", after: "w2", reason: "seq" }] }),
      runWorkers: (async (p: DelegationPlan): Promise<OrchestrationResult> => {
        const ids = runnableOf(p).map((w) => w.id);
        return { ran: ids.map((id) => ({ workerId: id, passed: true, changedFiles: [`src/${id}.ts`] })), skipped: [], conflicts: [] };
      }) as NonNullable<AutopilotSeams["runWorkers"]>,
      validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_r: string, _p: string, id: string) => {
        applyLog.push(id);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };
    const r = await runAutopilot(input(root, { config: cfg({ stopOnConflict: false }), seams }));
    assert.deepEqual(applyLog, ["w1", "w2"], "both disjoint patches applied, dependency order preserved");
    assert.deepEqual(r.appliedWorkers, ["w1", "w2"]);
    assert.equal(r.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integration: a worker whose check fails → no apply for it (and dependents never become runnable)", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const validateLog: string[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/w1.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/w2.ts"], dependsOn: ["w1"] });
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([w1, w2], { dependencies: [{ before: "w1", after: "w2", reason: "seq" }] }),
      runWorkers: (async (p: DelegationPlan): Promise<OrchestrationResult> => {
        const ids = runnableOf(p).map((w) => w.id);
        // w1's check FAILS.
        return { ran: ids.map((id) => ({ workerId: id, passed: id !== "w1", changedFiles: [] })), skipped: [], conflicts: [] };
      }) as NonNullable<AutopilotSeams["runWorkers"]>,
      validateWorker: (async (_r: string, _p: string, id: string) => {
        validateLog.push(id);
        return validation();
      }) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_r: string, _p: string, id: string) => {
        applyLog.push(id);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };
    const r = await runAutopilot(input(root, { config: cfg({ stopOnConflict: false }), seams }));
    assert.ok(!applyLog.includes("w1"), "a failed-check worker is never applied");
    assert.ok(!validateLog.includes("w1"), "a failed-check worker is never even validated");
    // w2 depends on w1, which was never applied → w2 must never have been applied either.
    assert.ok(!applyLog.includes("w2"), "dependents of a failed worker must not be applied");
    assert.ok(r.blockedWorkers.includes("w1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integration: acceptance-first missing proof → worker blocked, not applied", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([worker({ requireProductionChange: true })]),
      runWorkers: (async (): Promise<OrchestrationResult> => ({
        ran: [{ workerId: "w1", passed: true, changedFiles: ["src/a.ts"] }], skipped: [], conflicts: [],
      })) as NonNullable<AutopilotSeams["runWorkers"]>,
      // Validation reports the acceptance-first proof missing → not applyable.
      validateWorker: (async () =>
        validation({
          status: "invalid",
          applyable: false,
          failures: [{ code: "missing_validated_test", message: "no red→green proof", source: "patch" }],
        })) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_r: string, _p: string, id: string) => {
        applyLog.push(id);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };
    const r = await runAutopilot(input(root, { config: cfg({ acceptanceFirst: true, stopOnConflict: false }), seams }));
    assert.equal(applyLog.length, 0, "no apply when acceptance-first proof is missing");
    assert.ok(r.blockedWorkers.includes("w1"));
    assert.ok(!r.appliedWorkers.includes("w1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integration: patch conflict between workers → blocked, no automatic resolution", async () => {
  const root = await tmpRoot();
  try {
    const applyLog: string[] = [];
    const w1 = worker({ id: "w1", allowedPaths: ["src/shared.ts"] });
    const w2 = worker({ id: "w2", allowedPaths: ["src/shared.ts"] });
    const seams: AutopilotSeams = {
      buildPlan: fixedPlan([w1, w2]),
      runWorkers: (async (): Promise<OrchestrationResult> => ({
        ran: [
          { workerId: "w1", passed: true, changedFiles: ["src/shared.ts"] },
          { workerId: "w2", passed: true, changedFiles: ["src/shared.ts"] },
        ],
        skipped: [],
        conflicts: [{ a: "w1", b: "w2", paths: ["src/shared.ts"] }],
      })) as NonNullable<AutopilotSeams["runWorkers"]>,
      validateWorker: (async () => validation()) as NonNullable<AutopilotSeams["validateWorker"]>,
      applyWorker: (async (_r: string, _p: string, id: string) => {
        applyLog.push(id);
        return { ok: true, message: "" } as ApplyResult;
      }) as NonNullable<AutopilotSeams["applyWorker"]>,
    };
    const r = await runAutopilot(input(root, { config: cfg({ stopOnConflict: true }), seams }));
    assert.equal(r.status, "blocked");
    assert.equal(applyLog.length, 0, "conflicts are never auto-resolved");
    assert.match(r.summary, /conflict/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
