/**
 * Phase 9D — Multi-worker orchestration helpers.
 *
 * Pure helpers:
 *  - topoOrder
 *  - runnableWorkers
 *  - detectFileConflicts
 *
 * Driver:
 *  - runRunnable (sequential; injectable runOne seam)
 */

import { savePlan } from "./store.js";
import { runWorker } from "./workerRunner.js";
import type { DelegationPlan, WorkerRun, WorkerTask } from "./types.js";

export interface FileConflict {
  a: string;
  b: string;
  paths: string[];
}

export interface OrchestrationResult {
  ran: { workerId: string; passed: boolean; changedFiles: string[] }[];
  skipped: { workerId: string; reason: string }[];
  conflicts: FileConflict[];
}

export interface RunRunnableOptions {
  realRoot: string;
  signal: AbortSignal;
  mainEntry: string;
  provider: string;
  parentEnv?: NodeJS.ProcessEnv;
  delegateDepth?: number;
  onData?(chunk: string): void;
  runOne?(plan: DelegationPlan, worker: WorkerTask): Promise<WorkerRun>;
}

/**
 * Return worker ids in topological order (deps before dependents).
 * Own DFS cycle detection; throws on any cycle or unknown dependency.
 */
export function topoOrder(plan: DelegationPlan): string[] {
  const byId = new Map<string, WorkerTask>();
  for (const w of plan.workers) {
    if (byId.has(w.id)) throw new Error(`Duplicate worker id "${w.id}" in plan "${plan.id}".`);
    byId.set(w.id, w);
  }

  const ids = [...byId.keys()].sort();
  const state = new Map<string, 0 | 1 | 2>(); // 0 white, 1 gray, 2 black
  for (const id of ids) state.set(id, 0);

  const out: string[] = [];
  const stack: string[] = [];

  const visit = (id: string): void => {
    const color = state.get(id) ?? 0;
    if (color === 2) return;
    if (color === 1) {
      const cycleStart = stack.indexOf(id);
      const cyclePath = cycleStart >= 0
        ? [...stack.slice(cycleStart), id].join(" -> ")
        : `${id} -> ${id}`;
      throw new Error(`Dependency cycle detected: ${cyclePath}`);
    }

    const worker = byId.get(id);
    if (!worker) throw new Error(`Unknown worker "${id}" in plan "${plan.id}".`);

    state.set(id, 1);
    stack.push(id);
    for (const depId of [...worker.dependsOn].sort()) {
      if (!byId.has(depId)) {
        throw new Error(
          `Worker "${worker.id}" depends on missing worker "${depId}" (plan "${plan.id}").`,
        );
      }
      visit(depId);
    }
    stack.pop();
    state.set(id, 2);
    out.push(id);
  };

  for (const id of ids) visit(id);
  return out;
}

/**
 * Workers runnable in v1: status planned|failed AND all deps are applied.
 * A dep in "passed" is not enough in v1.
 */
export function runnableWorkers(plan: DelegationPlan): WorkerTask[] {
  const byId = new Map(plan.workers.map((w) => [w.id, w]));
  const runnableStatus = new Set(["planned", "failed"]);

  return plan.workers.filter((worker) => {
    if (!runnableStatus.has(worker.status)) return false;
    for (const depId of worker.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(
          `Worker "${worker.id}" depends on missing worker "${depId}" (plan "${plan.id}").`,
        );
      }
      if (dep.status !== "applied") return false;
    }
    return true;
  });
}

/**
 * Report overlapping changed paths for each worker pair. Deterministic and
 * deduplicated.
 */
export function detectFileConflicts(changedByWorker: Record<string, string[]>): FileConflict[] {
  const workerIds = Object.keys(changedByWorker).sort();
  const normalized = new Map<string, string[]>();

  for (const workerId of workerIds) {
    const unique = [...new Set((changedByWorker[workerId] ?? []).filter((p) => typeof p === "string"))].sort();
    normalized.set(workerId, unique);
  }

  const conflicts: FileConflict[] = [];
  for (let i = 0; i < workerIds.length; i++) {
    const a = workerIds[i]!;
    const aSet = new Set(normalized.get(a) ?? []);
    if (aSet.size === 0) continue;
    for (let j = i + 1; j < workerIds.length; j++) {
      const b = workerIds[j]!;
      const bPaths = normalized.get(b) ?? [];
      if (bPaths.length === 0) continue;
      const shared = bPaths.filter((p) => aSet.has(p));
      if (shared.length > 0) {
        conflicts.push({ a, b, paths: [...new Set(shared)].sort() });
      }
    }
  }

  return conflicts;
}

/**
 * Sequentially run runnable workers (topo-ordered). Never applies patches.
 * If a worker fails, mark it failed and skip all transitive dependents while
 * continuing on independent workers.
 */
export async function runRunnable(
  plan: DelegationPlan,
  opts: RunRunnableOptions,
): Promise<OrchestrationResult> {
  const byId = new Map(plan.workers.map((w) => [w.id, w]));
  const orderedIds = topoOrder(plan);
  const runnableIds = new Set(runnableWorkers(plan).map((w) => w.id));

  const reverseDeps = new Map<string, string[]>();
  for (const w of plan.workers) reverseDeps.set(w.id, []);
  for (const w of plan.workers) {
    for (const depId of w.dependsOn) {
      const list = reverseDeps.get(depId);
      if (!list) {
        throw new Error(`Worker "${w.id}" depends on missing worker "${depId}" (plan "${plan.id}").`);
      }
      list.push(w.id);
    }
  }

  const runOne = opts.runOne ?? (async (runPlan: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> => {
    const out = await runWorker({
      realRoot: opts.realRoot,
      plan: runPlan,
      worker,
      signal: opts.signal,
      mainEntry: opts.mainEntry,
      provider: opts.provider,
      parentEnv: opts.parentEnv,
      delegateDepth: opts.delegateDepth,
      onData: opts.onData,
    });
    return out.run;
  });

  const ran: { workerId: string; passed: boolean; changedFiles: string[] }[] = [];
  const ranIds = new Set<string>();
  const skippedReasons = new Map<string, string>();
  const blockedByFailed = new Map<string, string>();
  const changedByWorker: Record<string, string[]> = {};

  for (const workerId of orderedIds) {
    if (runnableIds.has(workerId)) continue;
    const worker = byId.get(workerId);
    if (!worker) continue;
    skippedReasons.set(workerId, initialSkipReason(worker, byId));
  }

  for (const workerId of orderedIds) {
    if (!runnableIds.has(workerId)) continue;

    const blockingFailedDep = blockedByFailed.get(workerId);
    if (blockingFailedDep) {
      skippedReasons.set(workerId, `depends on failed worker "${blockingFailedDep}"`);
      continue;
    }

    const worker = byId.get(workerId);
    if (!worker) {
      skippedReasons.set(workerId, "missing worker record");
      continue;
    }

    let run: WorkerRun | null = null;
    try {
      run = await runOne(plan, worker);
      worker.status = run.checkPassed ? "passed" : "failed";
      await savePlan(opts.realRoot, plan);
    } catch {
      worker.status = "failed";
      await savePlan(opts.realRoot, plan);
    }

    const passed = run?.checkPassed === true;
    const changedFiles = run?.changedFiles ?? [];
    ran.push({ workerId, passed, changedFiles });
    ranIds.add(workerId);
    changedByWorker[workerId] = changedFiles;

    if (!passed) {
      const dependents = collectDependents(workerId, reverseDeps);
      for (const depId of dependents) {
        if (ranIds.has(depId)) continue;
        if (!blockedByFailed.has(depId)) blockedByFailed.set(depId, workerId);
        skippedReasons.set(depId, `depends on failed worker "${workerId}"`);
      }
    }
  }

  const skipped = orderedIds
    .filter((workerId) => !ranIds.has(workerId) && skippedReasons.has(workerId))
    .map((workerId) => ({ workerId, reason: skippedReasons.get(workerId) ?? "skipped" }));

  const conflicts = detectFileConflicts(changedByWorker);

  return { ran, skipped, conflicts };
}

function collectDependents(startWorkerId: string, reverseDeps: Map<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(reverseDeps.get(startWorkerId) ?? [])];

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const next of reverseDeps.get(id) ?? []) stack.push(next);
  }

  return out;
}

function initialSkipReason(
  worker: WorkerTask,
  byId: Map<string, WorkerTask>,
): string {
  if (worker.status !== "planned" && worker.status !== "failed") {
    return `status is "${worker.status}"`;
  }

  for (const depId of worker.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) return `missing dependency "${depId}"`;
    if (dep.status !== "applied") {
      return `dependency "${depId}" is "${dep.status}" (must be "applied")`;
    }
  }

  return "not runnable";
}
