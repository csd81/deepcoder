/**
 * Phase — Coordinator Mode Delegation Loop.
 *
 * A multi-round orchestration loop where a coordinator model turn between rounds
 * inspects a RoundDigest (pass/fail, changed files, conflicts — NOT raw diffs)
 * and emits a CoordinatorDecision: which workers to integrate (gated through
 * applyWorker) and what new workers to spawn for the next round.
 *
 * Modeled on autopilot.ts (injected seams, no live model in tests, artifact
 * persistence). Every external dependency flows through the injected
 * `CoordinatorSeams` object.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runRunnableConcurrent as defaultRunWorkers } from "./orchestrator.js";
import { loadAndValidateWorker as defaultValidateWorker } from "./validation.js";
import { applyWorker as defaultApplyWorker } from "./apply.js";
import { savePlan } from "./store.js";
import { delegateDepthFromEnv } from "./workerRunner.js";
import { topoOrder } from "./orchestrator.js";
import type { DelegationPlan, WorkerTask, CoordinatorRound, CoordinatorDecision, RoundDigest } from "./types.js";
import type { OrchestrationResult } from "./orchestrator.js";
import type { WorkerValidation } from "./types.js";
import type { ApplyResult } from "./apply.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CoordinatorInput {
  /** Absolute path to the real workspace root. */
  realRoot: string;
  /** The seed delegation plan (pre-built, with initial workers). */
  plan: DelegationPlan;
  /** Maximum number of coordinator rounds. */
  maxRounds: number;
  /** Maximum concurrent workers per round. */
  maxConcurrency: number;
  /** When true, automatically apply workers listed in decision.integrate. */
  autoApply: boolean;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Injected seams for testing. */
  seams?: CoordinatorSeams;
  /** Optional confirm hook for apply. */
  confirm?: (prompt: string) => Promise<boolean>;
  /** Optional quality gate required flag. */
  qualityGateRequired?: boolean;
}

export interface CoordinatorResult {
  planId: string;
  status: "completed" | "blocked" | "failed" | "done";
  rounds: CoordinatorRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  summary: string;
}

export interface CoordinatorSeams {
  runWorkers?: typeof defaultRunWorkers;
  validateWorker?: typeof defaultValidateWorker;
  applyWorker?: typeof defaultApplyWorker;
  coordinatorTurn: (digest: RoundDigest) => Promise<CoordinatorDecision>;
}

/* ------------------------------------------------------------------ */
/*  Artifact persistence                                               */
/* ------------------------------------------------------------------ */

interface CoordinatorArtifact {
  planId: string;
  strategy: "coordinate";
  startedAt: string;
  finishedAt?: string;
  rounds: CoordinatorRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  summary: string;
}

function artifactPath(root: string, planId: string): string {
  return path.join(root, ".deepcoder", "delegations", planId, "coordinator.json");
}

export async function writeCoordinatorArtifact(
  root: string,
  planId: string,
  artifact: CoordinatorArtifact,
): Promise<void> {
  const p = artifactPath(root, planId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(artifact, null, 2), "utf8");
}

/* ------------------------------------------------------------------ */
/*  Digest builder                                                     */
/* ------------------------------------------------------------------ */

function buildDigest(
  round: number,
  runResult: OrchestrationResult,
  appliedThisRound: string[],
  blockedThisRound: string[],
  skippedThisRound: string[],
): RoundDigest {
  return {
    round,
    workers: runResult.ran.map((r) => ({
      id: r.workerId,
      status: r.passed ? "passed" : "failed",
      passed: r.passed,
      changedFiles: r.changedFiles,
    })),
    conflicts: runResult.conflicts.map((c) => ({
      a: c.a,
      b: c.b,
      paths: c.paths,
    })),
    appliedThisRound,
    blockedThisRound,
    skippedThisRound,
  };
}

/* ------------------------------------------------------------------ */
/*  Compute runnable workers from plan                                 */
/* ------------------------------------------------------------------ */

function computeRunnable(plan: DelegationPlan): WorkerTask[] {
  return plan.workers.filter((w) => {
    if (w.status !== "planned") return false;
    for (const depId of w.dependsOn) {
      const dep = plan.workers.find((dw) => dw.id === depId);
      if (!dep || dep.status !== "applied") return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/*  Validate and append new workers to plan                            */
/* ------------------------------------------------------------------ */

function appendWorkers(plan: DelegationPlan, nextWorkers: WorkerTask[]): void {
  const existingIds = new Set(plan.workers.map((w) => w.id));
  for (const w of nextWorkers) {
    if (existingIds.has(w.id)) {
      throw new Error(`Coordinator proposed duplicate worker id "${w.id}".`);
    }
    existingIds.add(w.id);
  }

  plan.workers.push(...nextWorkers);

  // Validate the updated plan has no cycles using topoOrder.
  try {
    topoOrder(plan);
  } catch (err) {
    // Roll back the append so the plan is not corrupted.
    plan.workers.length = plan.workers.length - nextWorkers.length;
    throw new Error(`Coordinator proposed workers introduce a cycle: ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main Loop                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run the coordinator delegation loop.
 *
 * Loop phases per round:
 *   1. Compute runnable workers from the plan (planned + deps applied).
 *   2. Run them via runRunnableConcurrent.
 *   3. Build a RoundDigest from the result.
 *   4. Call coordinatorTurn(digest) → CoordinatorDecision.
 *   5. For each decision.integrate id: validate + apply (gated).
 *   6. Append decision.nextWorkers to the plan (validated: no dups, no cycles).
 *   7. Persist coordinator.json.
 *   8. Repeat until done / no runnable workers / maxRounds.
 */
export async function runCoordinator(input: CoordinatorInput): Promise<CoordinatorResult> {
  const {
    realRoot,
    plan,
    maxRounds,
    maxConcurrency,
    autoApply,
    signal,
    seams,
    confirm: confirmFn,
    qualityGateRequired = false,
  } = input;

  // ── Nested-delegation guard ───────────────────────────────────────
  const depth = delegateDepthFromEnv(process.env);
  if (depth > 0) {
    return {
      planId: plan.id,
      status: "blocked",
      rounds: [],
      appliedWorkers: [],
      blockedWorkers: [],
      summary: `Nested delegation refused: this process is itself a delegated worker (depth ${depth}).`,
    };
  }

  // Resolve seams with defaults.
  const runWorkersFn = seams?.runWorkers ?? (defaultRunWorkers as NonNullable<CoordinatorSeams["runWorkers"]>);
  const validateWorkerFn = seams?.validateWorker ?? (defaultValidateWorker as NonNullable<CoordinatorSeams["validateWorker"]>);
  const applyWorkerFn = seams?.applyWorker ?? (defaultApplyWorker as NonNullable<CoordinatorSeams["applyWorker"]>);
  const coordinatorTurnFn = seams?.coordinatorTurn ?? (async (_digest: RoundDigest) => ({
    nextWorkers: [],
    integrate: [],
  }));

  const startedAt = new Date().toISOString();

  const allRounds: CoordinatorRound[] = [];
  const allApplied: string[] = [];
  const allBlocked: string[] = [];

  const effectiveMaxRounds = Math.max(1, maxRounds);

  // Ensure the seed plan is saved before the first round.
  await savePlan(realRoot, plan);

  for (let roundIdx = 1; roundIdx <= effectiveMaxRounds; roundIdx++) {
    if (signal.aborted) break;

    // ── 1. Compute runnable workers ─────────────────────────────────
    const runnable = computeRunnable(plan);
    if (runnable.length === 0) {
      // No more runnable workers — terminate.
      break;
    }

    const runnableIds = runnable.map((w) => w.id);

    // ── 2. Run workers ─────────────────────────────────────────────
    let runResult: OrchestrationResult;
    try {
      runResult = await runWorkersFn(plan, {
        realRoot,
        signal,
        mainEntry: "",
        provider: "",
        maxConcurrency,
        stopOnFirstFailure: true,
      } as Record<string, unknown>);
    } catch (err) {
      return {
        planId: plan.id,
        status: "failed",
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        summary: `Worker execution failed at round ${roundIdx}: ${(err as Error).message}`,
      };
    }

    // ── 3. Build RoundDigest ────────────────────────────────────────
    const skippedThisRound = runResult.skipped.map((s) => s.workerId);
    const roundApplied: string[] = [];
    const roundBlocked: string[] = [];

    // Check for conflicts first — conflicting workers are blocked.
    if (runResult.conflicts.length > 0) {
      const conflictedIds = new Set<string>();
      for (const c of runResult.conflicts) {
        conflictedIds.add(c.a);
        conflictedIds.add(c.b);
      }
      for (const id of conflictedIds) {
        const w = plan.workers.find((pw) => pw.id === id);
        if (w) w.status = "conflict";
        roundBlocked.push(id);
      }
    }

    // ── 4. Coordinator turn ─────────────────────────────────────────
    const digest = buildDigest(roundIdx, runResult, roundApplied, roundBlocked, skippedThisRound);

    let decision: CoordinatorDecision;
    try {
      decision = await coordinatorTurnFn(digest);
    } catch (err) {
      return {
        planId: plan.id,
        status: "failed",
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        summary: `Coordinator turn failed at round ${roundIdx}: ${(err as Error).message}`,
      };
    }

    // ── Check for done signal ──────────────────────────────────────
    if (decision.done) {
      // Record the round and finalize.
      const roundRecord: CoordinatorRound = {
        round: roundIdx,
        plannedWorkerIds: runnableIds,
        ran: runResult.ran,
        integrated: roundApplied,
        deferred: roundBlocked,
        coordinatorNote: decision.coordinatorNote,
      };
      allRounds.push(roundRecord);

      await savePlan(realRoot, plan);
      await writeCoordinatorArtifact(realRoot, plan.id, {
        planId: plan.id,
        strategy: "coordinate",
        startedAt,
        finishedAt: new Date().toISOString(),
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        summary: `Coordinator signaled done after round ${roundIdx}.`,
      });

      return {
        planId: plan.id,
        status: "done",
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        summary: `Coordinator signaled done after round ${roundIdx}.`,
      };
    }

    // ── 5. Integrate — apply each worker in decision.integrate ──────
    const integrationPaths = new Set<string>();
    for (const integrateId of decision.integrate) {
      if (roundBlocked.includes(integrateId)) continue;
      // Only integrate workers that actually ran and passed.
      const ranInfo = runResult.ran.find((r) => r.workerId === integrateId);
      if (!ranInfo || !ranInfo.passed) {
        roundBlocked.push(integrateId);
        continue;
      }

      let validation: WorkerValidation;
      try {
        validation = await validateWorkerFn(realRoot, plan.id, integrateId, {
          qualityGateRequired,
          alreadyChangedPaths: [...integrationPaths],
        });
      } catch {
        roundBlocked.push(integrateId);
        continue;
      }

      if (!validation.applyable) {
        roundBlocked.push(integrateId);
        continue;
      }

      if (autoApply) {
        const shouldApply = confirmFn
          ? await confirmFn(`Apply worker "${integrateId}"?`)
          : true;

        if (shouldApply) {
          try {
            const applyResult: ApplyResult = await applyWorkerFn(realRoot, plan.id, integrateId, {
              isTTY: !!confirmFn,
              confirmResult: true,
            });
            if (applyResult.ok) {
              roundApplied.push(integrateId);
              allApplied.push(integrateId);
              for (const p of ranInfo.changedFiles) integrationPaths.add(p);
              const appliedWorker = plan.workers.find((w) => w.id === integrateId);
              if (appliedWorker) appliedWorker.status = "applied";
            } else {
              roundBlocked.push(integrateId);
            }
          } catch {
            roundBlocked.push(integrateId);
          }
        } else {
          roundBlocked.push(integrateId);
        }
      } else {
        // autoApply=false — workers in integrate are deferred.
        roundBlocked.push(integrateId);
      }
    }

    for (const id of roundBlocked) {
      if (!allBlocked.includes(id)) allBlocked.push(id);
    }

    // ── 6. Append nextWorkers ──────────────────────────────────────
    if (decision.nextWorkers.length > 0) {
      try {
        appendWorkers(plan, decision.nextWorkers);
      } catch (err) {
        return {
          planId: plan.id,
          status: "failed",
          rounds: allRounds,
          appliedWorkers: allApplied,
          blockedWorkers: allBlocked,
          summary: `Failed to append coordinator-proposed workers: ${(err as Error).message}`,
        };
      }
    }

    // ── 7. Record round and persist ──────────────────────────────────
    const roundRecord: CoordinatorRound = {
      round: roundIdx,
      plannedWorkerIds: runnableIds,
      ran: runResult.ran,
      integrated: roundApplied,
      deferred: roundBlocked,
      coordinatorNote: decision.coordinatorNote,
    };
    allRounds.push(roundRecord);

    await savePlan(realRoot, plan);
    await writeCoordinatorArtifact(realRoot, plan.id, {
      planId: plan.id,
      strategy: "coordinate",
      startedAt,
      rounds: allRounds,
      appliedWorkers: [...allApplied],
      blockedWorkers: [...allBlocked],
      summary: "",
    });

    // If there are no more runnable workers and we didn't add any, stop.
    const nextRunnable = computeRunnable(plan);
    if (nextRunnable.length === 0 && decision.nextWorkers.length === 0) {
      break;
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────
  await savePlan(realRoot, plan);
  await writeCoordinatorArtifact(realRoot, plan.id, {
    planId: plan.id,
    strategy: "coordinate",
    startedAt,
    finishedAt: new Date().toISOString(),
    rounds: allRounds,
    appliedWorkers: allApplied,
    blockedWorkers: allBlocked,
    summary: allApplied.length > 0
      ? `Applied ${allApplied.length} worker(s), ${allBlocked.length} blocked.`
      : "No workers applied.",
  });

  const hasPlanned = plan.workers.some((w) => w.status === "planned");
  const hasFailed = plan.workers.some((w) => w.status === "failed");
  const status: CoordinatorResult["status"] =
    allBlocked.length > 0 || hasPlanned || hasFailed ? "blocked" : "completed";

  return {
    planId: plan.id,
    status,
    rounds: allRounds,
    appliedWorkers: allApplied,
    blockedWorkers: allBlocked,
    summary: allApplied.length > 0
      ? `Applied ${allApplied.length} worker(s), ${allBlocked.length} blocked.`
      : "No workers applied.",
  };
}
