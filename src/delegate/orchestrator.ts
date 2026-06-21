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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { savePlan } from "./store.js";
import { runWorker } from "./workerRunner.js";
import type { DelegationPlan, WorkerRun, WorkerTask, WorkerLockSet, WorkerBatch, OrchestrationTrace } from "./types.js";
import type { UiEvent } from "../ui/events.js";

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
  /** Structured UI events (worker_start/done) for a TUI/SDK consumer. */
  onUiEvent?(e: UiEvent): void;
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

    opts.onUiEvent?.({ type: "worker_start", id: workerId, label: worker.title });
    let run: WorkerRun | null = null;
    try {
      run = await runOne(plan, worker);
      worker.status = run.checkPassed ? "passed" : "failed";
      await savePlan(opts.realRoot, plan);
    } catch {
      worker.status = "failed";
      await savePlan(opts.realRoot, plan);
    }
    opts.onUiEvent?.({
      type: "worker_done",
      id: workerId,
      summary: `${run?.checkPassed ? "passed" : "failed"} · ${(run?.changedFiles ?? []).length} file(s) changed`,
    });

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

/* ------------------------------------------------------------------ */
/*  Phase 9I — Concurrent Subagent Orchestration Helpers               */
/* ------------------------------------------------------------------ */

export function workerLockSet(worker: WorkerTask): WorkerLockSet {
  const paths: string[] = [];
  const reasonByPath: Record<string, string> = {};

  if (worker.expectedFiles && worker.expectedFiles.length > 0) {
    for (const rule of worker.expectedFiles) {
      if (rule && typeof rule.path === "string") {
        paths.push(rule.path);
        reasonByPath[rule.path] = `expectedFiles rule: ${rule.mode}`;
      }
    }
  } else if (worker.allowedPaths && worker.allowedPaths.length > 0) {
    for (const p of worker.allowedPaths) {
      if (typeof p === "string") {
        paths.push(p);
        reasonByPath[p] = "allowedPaths";
      }
    }
  }

  if (paths.length === 0) {
    paths.push(".");
    reasonByPath["."] = "fallback: no path scope";
  }

  return {
    workerId: worker.id,
    paths: [...new Set(paths)].sort(),
    reasonByPath,
  };
}

function normalizePath(p: string): string {
  let np = p.trim();
  if (np === "" || np === "/") return ".";
  if (np.endsWith("/") && np.length > 1) {
    np = np.slice(0, -1);
  }
  return np;
}

function pathsConflict(p1: string, p2: string): boolean {
  if (p1 === "." || p2 === ".") return true;
  if (p1 === p2) return true;
  if (p2.startsWith(p1 + "/")) return true;
  if (p1.startsWith(p2 + "/")) return true;
  return false;
}

export function locksConflict(a: WorkerLockSet, b: WorkerLockSet): boolean {
  for (const pA of a.paths) {
    const normA = normalizePath(pA);
    for (const pB of b.paths) {
      const normB = normalizePath(pB);
      if (pathsConflict(normA, normB)) {
        return true;
      }
    }
  }
  return false;
}

export function buildRunnableBatches(
  plan: DelegationPlan,
  opts?: { maxConcurrency?: number },
): WorkerBatch[] {
  const maxConcurrency = opts?.maxConcurrency ?? 2;
  const orderedIds = topoOrder(plan);
  const runnable = runnableWorkers(plan);
  const runnableIds = new Set(runnable.map((w) => w.id));
  const sortedRunnableIds = orderedIds.filter((id) => runnableIds.has(id));

  const byId = new Map(plan.workers.map((w) => [w.id, w]));
  const batches: WorkerBatch[] = [];
  let batchCounter = 1;

  for (const workerId of sortedRunnableIds) {
    const worker = byId.get(workerId)!;
    const lockSet = workerLockSet(worker);

    let placed = false;
    for (const batch of batches) {
      if (batch.workerIds.length >= maxConcurrency) {
        continue;
      }
      let conflict = false;
      for (const existingLock of batch.locks) {
        if (locksConflict(lockSet, existingLock)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        batch.workerIds.push(workerId);
        batch.locks.push(lockSet);
        placed = true;
        break;
      }
    }

    if (!placed) {
      batches.push({
        id: `batch-${batchCounter++}`,
        workerIds: [workerId],
        locks: [lockSet],
      });
    }
  }

  return batches;
}

export class PlanSaveQueue {
  private pending = Promise.resolve();

  async enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
}

async function getWorkerChangedFiles(realRoot: string, planId: string, workerId: string): Promise<string[]> {
  try {
    const runPath = path.join(realRoot, ".deepcoder", "delegations", planId, "runs", workerId, "run.json");
    const raw = await fs.readFile(runPath, "utf8");
    const run = JSON.parse(raw) as WorkerRun;
    return run.changedFiles ?? [];
  } catch {
    return [];
  }
}

async function saveOrchestrationTrace(realRoot: string, planId: string, trace: OrchestrationTrace): Promise<void> {
  try {
    const tracePath = path.join(realRoot, ".deepcoder", "delegations", planId, "orchestration.json");
    await fs.mkdir(path.dirname(tracePath), { recursive: true });
    await fs.writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export interface RunConcurrentOptions extends RunRunnableOptions {
  maxConcurrency?: number;
  stopOnFirstFailure?: boolean;
}

export async function runRunnableConcurrent(
  plan: DelegationPlan,
  opts: RunConcurrentOptions,
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
  const allConflicts: FileConflict[] = [];

  // Initialize skip reasons for non-runnable workers
  for (const workerId of orderedIds) {
    if (runnableIds.has(workerId)) continue;
    const worker = byId.get(workerId);
    if (!worker) continue;
    skippedReasons.set(workerId, initialSkipReason(worker, byId));
  }

  const maxConcurrency = opts.maxConcurrency ?? 2;
  const batches = buildRunnableBatches(plan, { maxConcurrency });
  const saveQueue = new PlanSaveQueue();

  const trace: OrchestrationTrace = {
    planId: plan.id,
    startedAt: new Date().toISOString(),
    mode: "parallel",
    maxConcurrency,
    batches: [],
  };

  let stopTriggered = false;

  for (const batch of batches) {
    if (opts.signal.aborted || stopTriggered) {
      for (const workerId of batch.workerIds) {
        skippedReasons.set(workerId, opts.signal.aborted ? "aborted" : "skipped due to stopOnFirstFailure");
      }
      continue;
    }

    const batchTrace = {
      id: batch.id,
      workerIds: batch.workerIds,
      startedAt: new Date().toISOString(),
      finishedAt: undefined as string | undefined,
    };
    trace.batches.push(batchTrace);

    const batchRunResults = new Map<string, { passed: boolean; changedFiles: string[] }>();

    const promises = batch.workerIds.map(async (workerId) => {
      const worker = byId.get(workerId);
      if (!worker) return;

      if (opts.signal.aborted) {
        worker.status = "failed";
        await saveQueue.enqueue(async () => {
          await savePlan(opts.realRoot, plan);
          await saveOrchestrationTrace(opts.realRoot, plan.id, trace);
        });
        ran.push({ workerId, passed: false, changedFiles: [] });
        ranIds.add(workerId);
        batchRunResults.set(workerId, { passed: false, changedFiles: [] });
        return;
      }

      let run: WorkerRun | null = null;
      try {
        run = await runOne(plan, worker);
        worker.status = run.checkPassed ? "passed" : "failed";
      } catch (err) {
        worker.status = "failed";
      }

      const passed = worker.status === "passed";
      const changedFiles = run?.changedFiles ?? [];

      await saveQueue.enqueue(async () => {
        await savePlan(opts.realRoot, plan);
        await saveOrchestrationTrace(opts.realRoot, plan.id, trace);
      });

      ran.push({ workerId, passed, changedFiles });
      ranIds.add(workerId);
      batchRunResults.set(workerId, { passed, changedFiles });
    });

    await Promise.allSettled(promises);

    batchTrace.finishedAt = new Date().toISOString();

    // Post-run conflict detection
    const changedByWorker: Record<string, string[]> = {};
    const newlyPassedIds = new Set<string>();

    for (const workerId of batch.workerIds) {
      const runResult = batchRunResults.get(workerId);
      if (runResult && runResult.passed) {
        newlyPassedIds.add(workerId);
        changedByWorker[workerId] = runResult.changedFiles;
      }
    }

    for (const w of plan.workers) {
      if (w.status === "passed" && !newlyPassedIds.has(w.id)) {
        const files = await getWorkerChangedFiles(opts.realRoot, plan.id, w.id);
        changedByWorker[w.id] = files;
      }
    }

    const batchConflicts = detectFileConflicts(changedByWorker);
    allConflicts.push(...batchConflicts);

    const conflictingIds = new Set<string>();
    for (const conflict of batchConflicts) {
      if (newlyPassedIds.has(conflict.a) || newlyPassedIds.has(conflict.b)) {
        conflictingIds.add(conflict.a);
        conflictingIds.add(conflict.b);
      }
    }

    if (conflictingIds.size > 0) {
      for (const id of conflictingIds) {
        const w = byId.get(id);
        if (w) {
          w.status = "conflict";
        }
      }
      await saveQueue.enqueue(async () => {
        await savePlan(opts.realRoot, plan);
        await saveOrchestrationTrace(opts.realRoot, plan.id, trace);
      });
    }

    // Skip dependents of failed/conflict workers
    for (const workerId of batch.workerIds) {
      const worker = byId.get(workerId);
      if (!worker) continue;

      if (worker.status === "failed" || worker.status === "conflict") {
        const dependents = collectDependents(workerId, reverseDeps);
        for (const depId of dependents) {
          if (ranIds.has(depId)) continue;
          if (!blockedByFailed.has(depId)) {
            blockedByFailed.set(depId, workerId);
          }
          const reason = worker.status === "failed"
            ? `depends on failed worker "${workerId}"`
            : `depends on conflicting worker "${workerId}"`;
          skippedReasons.set(depId, reason);
        }
      }
    }

    if (opts.stopOnFirstFailure) {
      for (const workerId of batch.workerIds) {
        const worker = byId.get(workerId);
        if (worker && (worker.status === "failed" || worker.status === "conflict")) {
          stopTriggered = true;
          break;
        }
      }
    }
  }

  trace.finishedAt = new Date().toISOString();
  await saveQueue.enqueue(async () => {
    await saveOrchestrationTrace(opts.realRoot, plan.id, trace);
  });

  const skipped = orderedIds
    .filter((workerId) => !ranIds.has(workerId) && skippedReasons.has(workerId))
    .map((workerId) => ({ workerId, reason: skippedReasons.get(workerId) ?? "skipped" }));

  // Deduplicate conflicts
  const seenConflicts = new Set<string>();
  const uniqueConflicts: FileConflict[] = [];
  for (const c of allConflicts) {
    const key = `${c.a} <-> ${c.b}`;
    if (!seenConflicts.has(key)) {
      seenConflicts.add(key);
      uniqueConflicts.push(c);
    }
  }

  return { ran, skipped, conflicts: uniqueConflicts };
}
