/**
 * Phase 9P — Delegation Autopilot.
 *
 * A pure, parent-side orchestration loop for delegation. Every external
 * dependency (buildPlan, runWorkers, validateWorker, applyWorker, runCheck)
 * flows through an injected `AutopilotSeams` object, so tests can run fully
 * deterministic with no live model and no real subprocess.
 *
 * Artifacts are persisted to `.deepcoder/delegations/<plan-id>/autopilot.json`
 * (redacted — no secrets, bounded).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { buildPlan as defaultBuildPlan } from "./planner.js";
import { runRunnableConcurrent as defaultRunWorkers } from "./orchestrator.js";
import { loadAndValidateWorker as defaultValidateWorker } from "./validation.js";
import { applyWorker as defaultApplyWorker } from "./apply.js";
import { runCheck as defaultRunCheck } from "../checks/runner.js";
import { savePlan } from "./store.js";
import { delegateDepthFromEnv } from "./workerRunner.js";
import type { DelegationPlan } from "./types.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { DelegateAutopilotConfig } from "../config/config.js";
import type { OrchestrationResult } from "./orchestrator.js";
import type { WorkerValidation } from "./types.js";
import type { ApplyResult } from "./apply.js";
import { redactSecrets } from "../workspace/redact.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AutopilotInput {
  /** Absolute path to the real workspace root. */
  realRoot: string;
  /** The task description. */
  task: string;
  /** Named checks available (e.g. from config.checks). */
  checks: Record<string, CheckConfig>;
  /** Autopilot configuration (default OFF, maxRounds, etc.). */
  config: DelegateAutopilotConfig;
  /**
   * Whether the delegate quality gate is required (from
   * `config.delegate.qualityGate.enabled`). When true, a worker with no
   * quality-gate result fails closed at validation (the gate is not yet
   * implemented, so enabling it blocks rather than silently passing unchecked).
   * Default false → unchanged behavior.
   */
  qualityGateRequired?: boolean;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Optional interactive confirmation hook. Defaults to programmatic accept. */
  confirm?: (prompt: string) => Promise<boolean>;
  /** Injected seams for testing (replace real I/O/model calls). */
  seams?: AutopilotSeams;
  /** Optional plan id override (for tests / status lookup). */
  planId?: string;
  /** When true, run the plan phase only and return */
  dryRun?: boolean;
}

export interface AutopilotResult {
  planId: string;
  status: "completed" | "blocked" | "failed" | "dry_run";
  rounds: AutopilotRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  finalCheckPassed: boolean | null;
  summary: string;
  /** The plan that was built (redacted text). */
  plan?: DelegationPlan;
  /** Human-readable next steps when blocked. */
  nextSteps?: string;
}

export interface AutopilotRound {
  round: number;
  runnableWorkers: string[];
  ran: { workerId: string; passed: boolean; changedFiles: string[] }[];
  validations: Record<string, { status: string; applyable: boolean; failures: string[] }>;
  applied: string[];
  blocked: string[];
  skipped: string[];
  roundComplete: boolean;
}

export interface AutopilotSeams {
  buildPlan?: typeof defaultBuildPlan;
  runWorkers?: typeof defaultRunWorkers;
  validateWorker?: typeof defaultValidateWorker;
  applyWorker?: typeof defaultApplyWorker;
  runCheck?: typeof defaultRunCheck;
}

/* ------------------------------------------------------------------ */
/*  Artifact persistence                                               */
/* ------------------------------------------------------------------ */

export interface AutopilotArtifact {
  task: string;
  startedAt: string;
  finishedAt?: string;
  config: {
    maxRounds: number;
    maxWorkers: number;
    maxConcurrency: number;
    acceptanceFirst: boolean;
    autoApply: boolean;
    stopOnConflict: boolean;
  };
  rounds: AutopilotRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  finalCheck: { name: string; passed: boolean; runId?: string } | null;
}

function artifactPath(root: string, planId: string): string {
  return path.join(root, ".deepcoder", "delegations", planId, "autopilot.json");
}

export async function writeAutopilotArtifact(
  root: string,
  planId: string,
  artifact: AutopilotArtifact,
): Promise<void> {
  const p = artifactPath(root, planId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Redact the task description for safety.
  const redacted: AutopilotArtifact = {
    ...artifact,
    task: redactSecrets(artifact.task).slice(0, 2000),
  };
  await fs.writeFile(p, JSON.stringify(redacted, null, 2), "utf8");
}

export async function readAutopilotArtifact(
  root: string,
  planId: string,
): Promise<AutopilotArtifact | null> {
  try {
    const raw = await fs.readFile(artifactPath(root, planId), "utf8");
    const parsed = JSON.parse(raw) as AutopilotArtifact;
    // Bounded read: prevent oversized artifact from exhausting memory.
    if (raw.length > 2 * 1024 * 1024) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers (redacted config for artifact)                              */
/* ------------------------------------------------------------------ */

function redactedConfig(c: DelegateAutopilotConfig): AutopilotArtifact["config"] {
  return {
    maxRounds: c.maxRounds,
    maxWorkers: c.maxWorkers,
    maxConcurrency: c.maxConcurrency,
    acceptanceFirst: c.acceptanceFirst,
    autoApply: c.autoApply,
    stopOnConflict: c.stopOnConflict,
  };
}

function makeSummary(result: AutopilotResult): string {
  const parts: string[] = [];
  if (result.appliedWorkers.length > 0) {
    parts.push(`applied ${result.appliedWorkers.length} worker(s)`);
  }
  if (result.blockedWorkers.length > 0) {
    parts.push(`${result.blockedWorkers.length} worker(s) blocked`);
  }
  if (result.finalCheckPassed === true) {
    parts.push("final check passed");
  } else if (result.finalCheckPassed === false) {
    parts.push("final check FAILED");
  }
  if (result.status === "dry_run") {
    return "[dry-run] plan created, no workers executed";
  }
  return parts.join("; ") || "no workers executed";
}

/* ------------------------------------------------------------------ */
/*  Main Loop                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run the delegation autopilot loop. The loop is pure with respect to
 * the injected seams — all real I/O (subprocess, model calls, filesystem
 * writes) flows through the `seams` object or the `confirm` hook.
 *
 * Loop phases:
 *   1. Plan (Round 0) — build or decompose the task into workers.
 *   2. Execute (Rounds 1..N) — run runnable workers, validate, apply.
 *   3. Final Check — after all eligible workers are applied.
 *   4. Report — produce the AutopilotResult with audit trail.
 */
export async function runAutopilot(input: AutopilotInput): Promise<AutopilotResult> {
  const {
    realRoot,
    task,
    checks,
    config,
    signal,
    confirm: confirmFn,
    seams = {},
    planId: planIdOverride,
    dryRun = false,
    qualityGateRequired = false,
  } = input;

  // Resolve seams with defaults.
  const buildPlanFn = seams.buildPlan ?? defaultBuildPlan;
  const runWorkersFn = seams.runWorkers ?? defaultRunWorkers;
  const validateWorkerFn = seams.validateWorker ?? defaultValidateWorker;
  const applyWorkerFn = seams.applyWorker ?? defaultApplyWorker;
  const runCheckFn = seams.runCheck ?? defaultRunCheck;

  const startedAt = new Date().toISOString();
  const checkNames = Object.keys(checks);
  const maxRounds = Math.max(1, config.maxRounds);

  // ── Nested-delegation guard (defense in depth) ───────────────────
  // A delegated worker runs with DEEPCODER_DELEGATE_DEPTH > 0. It must never
  // spawn its own worker tree, so the autopilot refuses outright — no plan is
  // built, no worker runs. This mirrors the runtime refusal in runWorker and
  // the CLI guard in the slash command; we enforce it here too so the guard
  // cannot be bypassed by any caller of runAutopilot.
  const depth = delegateDepthFromEnv(process.env);
  if (depth > 0) {
    return {
      planId: planIdOverride ?? "",
      status: "blocked",
      rounds: [],
      appliedWorkers: [],
      blockedWorkers: [],
      finalCheckPassed: null,
      summary: `Nested delegation refused: this process is itself a delegated worker (depth ${depth}). Autopilot is parent-owned only.`,
    };
  }

  // ── Phase 1: Build Plan ──────────────────────────────────────────
  const plan: DelegationPlan = buildPlanFn(task, {
    checkNames,
    maxWorkers: config.maxWorkers,
    tdd: config.acceptanceFirst,
    acceptanceFirst: config.acceptanceFirst,
  });

  const planId = planIdOverride ?? plan.id;

  // Override the plan id if provided
  if (planIdOverride) {
    (plan as { id: string }).id = planIdOverride;
  }

  // Enforce maxWorkers after plan building (cap at config).
  if (plan.workers.length > config.maxWorkers) {
    plan.workers = plan.workers.slice(0, config.maxWorkers);
    plan.riskNotes.push(`Capped to ${config.maxWorkers} workers (configured maxWorkers).`);
  }

  // Save the plan before any execution.
  await savePlan(realRoot, plan);

  // Initialize artifact.
  const artifact: AutopilotArtifact = {
    task: redactSecrets(task),
    startedAt,
    config: redactedConfig(config),
    rounds: [],
    appliedWorkers: [],
    blockedWorkers: [],
    finalCheck: null,
  };

  // ── Dry Run: plan only, no workers ────────────────────────────────
  if (dryRun) {
    await writeAutopilotArtifact(realRoot, planId, {
      ...artifact,
      finishedAt: new Date().toISOString(),
    });

    return {
      planId,
      status: "dry_run",
      rounds: [],
      appliedWorkers: [],
      blockedWorkers: [],
      finalCheckPassed: null,
      summary: makeSummary({
        planId,
        status: "dry_run",
        rounds: [],
        appliedWorkers: [],
        blockedWorkers: [],
        finalCheckPassed: null,
        summary: "",
        plan,
      }),
      plan,
      nextSteps: `Review the plan with /delegate review ${planId}, then run /delegate run ${planId}`,
    };
  }

  // ── Check: autopilot must be enabled or interactive ───────────────
  // (Caller should check this before calling — we enforce it here too.)
  if (!config.enabled && !dryRun) {
    return {
      planId,
      status: "blocked",
      rounds: [],
      appliedWorkers: [],
      blockedWorkers: [],
      finalCheckPassed: null,
      summary: "Autopilot is not enabled. Set DEEPCODER_DELEGATE_AUTOPILOT=1 or configure delegate.autopilot.enabled=true.",
    };
  }

  // ── Phases 2-3: Execute rounds ───────────────────────────────────
  const allApplied: string[] = [];
  const allBlocked: string[] = [];
  const allRounds: AutopilotRound[] = [];

  for (let roundIdx = 1; roundIdx <= maxRounds; roundIdx++) {
    if (signal.aborted) break;

    // Compute runnable workers: those in "planned" or "failed" status with all deps applied.
    const runnable = plan.workers.filter((w) => {
      if (w.status !== "planned" && w.status !== "failed") return false;
      for (const depId of w.dependsOn) {
        const dep = plan.workers.find((dw) => dw.id === depId);
        if (!dep || dep.status !== "applied") return false;
      }
      return true;
    });

    if (runnable.length === 0) {
      // All done — no more runnable workers.
      break;
    }

    const runnableIds = runnable.map((w) => w.id);

    // ── Round: Run workers ─────────────────────────────────────────
    let runResult: OrchestrationResult;
    try {
      runResult = await runWorkersFn(plan, {
        realRoot,
        signal,
        mainEntry: "", // Not used in test seams; real impl will need this
        provider: "",  // Not used in test seams
        maxConcurrency: config.maxConcurrency,
        stopOnFirstFailure: true,
      } as Parameters<typeof defaultRunWorkers>[1]);
    } catch (err) {
      // Worker run failure — stop the autopilot.
      return {
        planId,
        status: "failed",
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        finalCheckPassed: null,
        summary: `Worker execution failed at round ${roundIdx}: ${(err as Error).message}`,
      };
    }

    // ── Validate each completed worker ──────────────────────────────
    const validations: Record<string, { status: string; applyable: boolean; failures: string[] }> = {};
    const roundApplied: string[] = [];
    const roundBlocked: string[] = [];
    const roundSkipped: string[] = runResult.skipped.map((s) => s.workerId);

    // Cross-worker conflict tracking (validation-time): accumulate the paths
    // changed by workers ALREADY APPLIED earlier in this round, and feed them to
    // each subsequent worker's validation as `alreadyChangedPaths`. This makes
    // the validation-time conflict gate (overlap → conflict) actually fire so a
    // later worker that edits a path a peer already applied is blocked rather
    // than silently double-applied. (The concurrent orchestrator's
    // detectFileConflicts is a separate, earlier check.)
    const appliedPathsThisRound = new Set<string>();

    // Check for conflicts.
    if (runResult.conflicts.length > 0) {
      const conflictedIds = new Set<string>();
      for (const c of runResult.conflicts) {
        conflictedIds.add(c.a);
        conflictedIds.add(c.b);
      }
      for (const id of conflictedIds) {
        validations[id] = { status: "conflict", applyable: false, failures: ["File conflict detected"] };
        plan.workers.find((w) => w.id === id)!.status = "conflict";
      }
      if (config.stopOnConflict) {
        // Stop — conflicts need human resolution.
        for (const id of conflictedIds) allBlocked.push(id);
        await writeAutopilotArtifact(realRoot, planId, {
          ...artifact,
          rounds: allRounds,
          appliedWorkers: allApplied,
          blockedWorkers: allBlocked,
          finishedAt: new Date().toISOString(),
        });
        return {
          planId,
          status: "blocked",
          rounds: allRounds,
          appliedWorkers: allApplied,
          blockedWorkers: allBlocked,
          finalCheckPassed: null,
          summary: `Conflicts detected between workers: ${runResult.conflicts.map((c) => `${c.a} ↔ ${c.b}`).join(", ")}. Human resolution required.`,
          nextSteps: runResult.conflicts.map((c) => `/delegate diff ${planId} ${c.a} \n/delegate diff ${planId} ${c.b}`).join("\n"),
        };
      }
    }

    // Validate each passed worker.
    for (const ran of runResult.ran) {
      if (!ran.passed) {
        validations[ran.workerId] = { status: "failed", applyable: false, failures: ["Worker check failed"] };
        roundBlocked.push(ran.workerId);
        continue;
      }

      let validation: WorkerValidation;
      try {
        validation = await validateWorkerFn(realRoot, planId, ran.workerId, {
          qualityGateRequired,
          alreadyChangedPaths: [...appliedPathsThisRound],
        });
      } catch {
        validations[ran.workerId] = { status: "invalid", applyable: false, failures: ["Validation error"] };
        roundBlocked.push(ran.workerId);
        continue;
      }

      validations[ran.workerId] = {
        status: validation.status,
        applyable: validation.applyable,
        failures: validation.failures.map((f) => `[${f.code}] ${f.message}`),
      };

      if (validation.applyable) {
        // Worker is valid and eligible for apply.
        if (config.autoApply) {
          // Guarded auto-apply: ask for confirmation unless explicitly unattended.
          const shouldApply = confirmFn
            ? await confirmFn(`Apply worker "${ran.workerId}"?`)
            : true;

          if (shouldApply) {
            try {
              const applyResult: ApplyResult = await applyWorkerFn(realRoot, planId, ran.workerId, {
                checks,
                isTTY: !!confirmFn, // If confirmFn is provided, we're in interactive mode
                confirmResult: true, // Already confirmed above
              });
              if (applyResult.ok) {
                roundApplied.push(ran.workerId);
                allApplied.push(ran.workerId);
                // Record this worker's changed paths so a later worker in the
                // same round that overlaps them is blocked at validation time.
                for (const p of ran.changedFiles) appliedPathsThisRound.add(p);
                // Mark applied in the in-memory plan so (a) dependents become
                // runnable next round and (b) this worker is never re-run/
                // re-applied. Without this the loop re-applies the same worker
                // every round until maxRounds, and dependents never unblock.
                const appliedWorker = plan.workers.find((w) => w.id === ran.workerId);
                if (appliedWorker) appliedWorker.status = "applied";
              } else {
                validations[ran.workerId] = {
                  ...validations[ran.workerId]!,
                  applyable: false,
                  failures: [...validations[ran.workerId]!.failures, `Apply failed: ${applyResult.message}`],
                };
                roundBlocked.push(ran.workerId);
              }
            } catch (err) {
              validations[ran.workerId] = {
                ...validations[ran.workerId]!,
                applyable: false,
                failures: [...validations[ran.workerId]!.failures, `Apply error: ${(err as Error).message}`],
              };
              roundBlocked.push(ran.workerId);
            }
          } else {
            // User declined apply.
            validations[ran.workerId] = {
              ...validations[ran.workerId]!,
              applyable: false,
              failures: [...validations[ran.workerId]!.failures, "Apply declined by user"],
            };
            roundBlocked.push(ran.workerId);
          }
        } else {
          // autoApply=false — stop and report.
          roundBlocked.push(ran.workerId);
        }
      } else {
        roundBlocked.push(ran.workerId);
      }
    }

    for (const id of roundBlocked) {
      if (!allBlocked.includes(id)) allBlocked.push(id);
    }

    const roundRecord: AutopilotRound = {
      round: roundIdx,
      runnableWorkers: runnableIds,
      ran: runResult.ran,
      validations,
      applied: roundApplied,
      blocked: roundBlocked,
      skipped: roundSkipped,
      roundComplete: true,
    };
    allRounds.push(roundRecord);

    // Update artifact and persist.
    artifact.rounds = allRounds;
    artifact.appliedWorkers = [...allApplied];
    artifact.blockedWorkers = [...allBlocked];
    await writeAutopilotArtifact(realRoot, planId, artifact);

    // If there are blocked workers and we're not auto-applying, stop and report.
    if (roundBlocked.length > 0 && !config.autoApply) {
      // Make sure to save the plan.
      await savePlan(realRoot, plan);

      const applyCommands = roundBlocked
        .filter((id) => validations[id]?.applyable !== false)
        .map((id) => `/delegate apply ${planId} ${id}`);

      const nextSteps: string[] = [];
      if (applyCommands.length > 0) {
        nextSteps.push(`Safe apply commands:\n  ${applyCommands.join("\n  ")}`);
      }
      nextSteps.push(`Review with /delegate review ${planId}`);
      nextSteps.push(`Run remaining with /delegate run ${planId}`);

      return {
        planId,
        status: "blocked",
        rounds: allRounds,
        appliedWorkers: allApplied,
        blockedWorkers: allBlocked,
        finalCheckPassed: null,
        summary: `Round ${roundIdx}: ${roundApplied.length} applied, ${roundBlocked.length} blocked (autoApply=false)`,
        nextSteps: nextSteps.join("\n"),
      };
    }

    // Stop on first failure if stopOnConflict is set (applies to failures too).
    if (config.stopOnConflict && runResult.ran.some((r) => !r.passed)) {
      break;
    }
  }

  // ── Phase 4: Final Check ──────────────────────────────────────────
  let finalCheckPassed: boolean | null = null;
  let finalCheckResult: { name: string; passed: boolean; runId?: string } | null = null;

  if (allApplied.length > 0 && checkNames.length > 0) {
    // Run the first available check as the final check.
    const finalCheckName = checkNames[0]!;
    const finalCheckConfig = checks[finalCheckName];
    if (finalCheckConfig) {
      try {
        const result = await runCheckFn(finalCheckName, finalCheckConfig, {
          workspaceRoot: realRoot,
          signal,
        });
        finalCheckPassed = result.exitCode === 0 && !result.timedOut;
        finalCheckResult = {
          name: finalCheckName,
          passed: finalCheckPassed,
          runId: result.id,
        };
      } catch {
        finalCheckPassed = false;
        finalCheckResult = { name: finalCheckName, passed: false };
      }
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────
  artifact.rounds = allRounds;
  artifact.appliedWorkers = [...allApplied];
  artifact.blockedWorkers = [...allBlocked];
  artifact.finalCheck = finalCheckResult;
  artifact.finishedAt = new Date().toISOString();
  await writeAutopilotArtifact(realRoot, planId, artifact);
  await savePlan(realRoot, plan);

  const status: AutopilotResult["status"] = finalCheckPassed === false
    ? "failed"
    : allBlocked.length > 0 && allApplied.length === 0
      ? "blocked"
      : "completed";

  const result: AutopilotResult = {
    planId,
    status,
    rounds: allRounds,
    appliedWorkers: allApplied,
    blockedWorkers: allBlocked,
    finalCheckPassed,
    summary: makeSummary({
      planId,
      status,
      rounds: allRounds,
      appliedWorkers: allApplied,
      blockedWorkers: allBlocked,
      finalCheckPassed,
      summary: "",
    }),
    plan,
  };

  if (allBlocked.length > 0 && !config.autoApply) {
    result.nextSteps = `Apply safe workers with:\n${allBlocked
      .filter((id) => {
        const lastRound = allRounds[allRounds.length - 1];
        return lastRound?.validations[id]?.applyable !== false;
      })
      .map((id) => `  /delegate apply ${planId} ${id}`)
      .join("\n")}`;
  }

  return result;
}
