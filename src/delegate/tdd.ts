/**
 * Phase 9L — TDD Delegated Workers orchestration.
 *
 * Provides `runWorkerTdd` which implements the TDD lifecycle:
 *   1. Repro Phase — write/update only test files
 *   2. Red Proof — verify repro fails on baseline
 *   3. Fix Phase — fix production code
 *   4. Green Proof — verify repro + checks pass
 *
 * Non-TDD workers are passed through unchanged (delegated to the existing
 * `runWorker`).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createIsolatedWorkspace } from "../workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION, type WorkspaceIsolationConfig } from "../workspaceIsolation/types.js";
import { runBoundedProcess, type BoundedProcessResult } from "../process/runBoundedProcess.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { savePlan } from "./store.js";
import { assertSafeId } from "../workspace/paths.js";
import { buildReproPhasePrompt, buildFixPhasePrompt } from "./tddPrompts.js";
import { writeTddRecord, saveTddCheckRun } from "./tddArtifacts.js";
import { validatePatch } from "./patchValidator.js";
import { runWorker, type RunWorkerResult, type SpawnFn } from "./workerRunner.js";
import { parseTapResults, computeCoverage, deliverablesNotGreen } from "./coverage.js";
import type { CoverageReport } from "./coverage.js";
import type { DelegationPlan, WorkerRun, WorkerTask, WorkerTddRun, WorkerIsolationRecord } from "./types.js";
import type { CheckConfig } from "../config/fileConfig.js";

/* ------------------------------------------------------------------ */
/*  Coverage probe (Phase 9M)                                          */
/* ------------------------------------------------------------------ */

export interface CoverageProbeResult {
  /** Captured TAP output of the authored test command. */
  tap: string;
  exitCode: number;
  /** True iff the (config-derived) command was refused by the classifier. */
  refused: boolean;
  runId?: string;
}

/**
 * Runs the configured `testCommand` in a worktree and returns its TAP output.
 * Injectable so orchestration tests can drive the manifest flow without a real
 * test run. The default routes through `runCheck` (classifier-gated, bounded,
 * logged) and reads back the persisted log.
 */
export type CoverageProbe = (args: {
  workspaceRoot: string;
  testCommand: string;
  signal: AbortSignal;
}) => Promise<CoverageProbeResult>;

async function defaultCoverageProbe(args: {
  workspaceRoot: string;
  testCommand: string;
  signal: AbortSignal;
}): Promise<CoverageProbeResult> {
  const { workspaceRoot, testCommand, signal } = args;
  try {
    const run = await runCheck(
      "tdd-coverage",
      { command: testCommand },
      { workspaceRoot, signal },
    );
    let tap = "";
    try {
      tap = await fs.readFile(path.join(workspaceRoot, run.logPath), "utf8");
    } catch {
      // No log → empty TAP; coverage will read as uncovered (fails closed).
    }
    return { tap, exitCode: run.exitCode ?? 1, refused: false, runId: run.id };
  } catch (err) {
    if (err instanceof CheckRefusedError) {
      // A config-derived command was refused — fail closed, do not run it elsewhere.
      return { tap: "", exitCode: 126, refused: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RunWorkerTddInput {
  realRoot: string;
  plan: DelegationPlan;
  worker: WorkerTask;
  signal: AbortSignal;
  /** Absolute path to the Deepcoder CLI entrypoint (src/cli/main.ts). */
  mainEntry: string;
  /** Resolved provider name (decides OPENAI_API_KEY forwarding). */
  provider: string;
  /** Current delegation depth; > 0 means we are ourselves a worker → refuse. */
  delegateDepth?: number;
  /** Parent env to copy the allowlist from. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Isolation config for the worktree. Defaults to the standard config. */
  isolationConfig?: WorkspaceIsolationConfig;
  /** Injectable spawn seam. Defaults to runBoundedProcess; tests inject a fake. */
  spawnWorker?: SpawnFn;
  onData?(chunk: string): void;
  /** Retain the worktree after the run (default: clean it up). */
  keepWorktree?: boolean;
  timeoutMs?: number;
  /** Named checks available for red/green proof. */
  checks?: Record<string, CheckConfig>;
  /** Phase 9M — injectable coverage probe (manifest mode). Tests inject a fake. */
  runCoverageProbe?: CoverageProbe;
}

/* ------------------------------------------------------------------ */
/*  runWorkerTdd                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a delegated worker with optional TDD lifecycle.
 *
 * - If the worker has no `tdd` requirement, delegates to the existing `runWorker`.
 * - If TDD is required, runs the full repro → red → fix → green lifecycle.
 * - Returns a WorkerRun (same shape as runWorker) with `tdd` metadata attached.
 */
export async function runWorkerTdd(input: RunWorkerTddInput): Promise<RunWorkerResult> {
  const { worker } = input;

  // Non-TDD workers: pass through to the existing runner unchanged.
  if (!worker.tdd) {
    return runWorker(input);
  }

  // TDD-required worker: run the full lifecycle.
  const tdd = worker.tdd;
  const reproPaths: string[] = [];
  const warnings: string[] = [];

  // Validate ids before any path construction.
  assertSafeId(input.plan.id);
  assertSafeId(worker.id);

  const parentEnv = input.parentEnv ?? process.env;
  const spawnWorker = input.spawnWorker ?? runBoundedProcess;
  const startedAt = new Date().toISOString();

  // Mark running and persist.
  worker.status = "running";
  await savePlan(input.realRoot, input.plan);

  // ── Step 1: Repro Phase ──────────────────────────────────────────
  // Create an isolated worktree for the repro phase.
  const reproIso = await createIsolatedWorkspace(
    input.realRoot,
    input.isolationConfig ?? {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: "patch",
      provision: [],
    },
  );

  const reproPrompt = buildReproPhasePrompt(worker, input.plan);
  const reproCmd = buildTddWorkerCommand(input.mainEntry, reproPrompt);

  try {
    await spawnWorker({
      file: reproCmd.file,
      args: reproCmd.args,
      cwd: reproIso.isolatedRoot,
      env: buildTddWorkerEnv(parentEnv, input.provider, input.delegateDepth ?? 0),
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 30 * 60_000,
      maxCaptureBytes: 1_000_000,
      shell: false,
      onData: input.onData,
    });
  } catch (err) {
    await cleanupIso(reproIso);
    worker.status = "failed";
    await savePlan(input.realRoot, input.plan).catch(() => {});
    throw err;
  }

  // Capture the repro patch.
  const reproPatch = await reproIso.diff();
  const reproChangedFiles = await reproIso.changedFiles();

  // Validate repro patch: must only touch allowed test paths.
  const reproValidation = validatePatch({
    patchText: reproPatch,
    allowedPaths: tdd.allowedTestPaths ?? [],
    forbiddenPaths: worker.forbiddenPaths,
    allowEmpty: !!tdd.allowNoReproJustification,
  });

  if (!reproValidation.ok) {
    // Repro patch is invalid — record as repro_missing.
    await cleanupIso(reproIso);
    const tddRun: WorkerTddRun = {
      required: true,
      status: "repro_missing",
      reproPaths: [],
      warnings: reproValidation.failures.map((f) => f.message),
    };
    await writeTddRecord(input.realRoot, input.plan.id, worker.id, tddRun);
    worker.status = "failed";
    await savePlan(input.realRoot, input.plan);

    return buildFailedTddResult(input, worker, startedAt, tddRun, reproIso);
  }

  // Record repro paths.
  for (const p of reproChangedFiles) {
    reproPaths.push(p);
  }

  // Save repro patch.
  const runDir = path.join(input.realRoot, ".deepcoder", "delegations", input.plan.id, "runs", worker.id);
  await fs.mkdir(runDir, { recursive: true });
  if (reproPatch.trim().length > 0) {
    await fs.writeFile(path.join(runDir, "repro.patch"), reproPatch, "utf8");
  }

  // Clean up repro worktree.
  await cleanupIso(reproIso);

  // ── Step 2: Red Proof ────────────────────────────────────────────
  // Create a fresh baseline worktree, apply the repro patch, run the check.
  const baselineIso = await createIsolatedWorkspace(
    input.realRoot,
    input.isolationConfig ?? {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: "patch",
      provision: [],
    },
  );

  let redConfirmed = false;
  let redRunId: string | undefined;
  let redSummary = "";

  // Phase 9M — manifest coverage mode.
  const deliverables = tdd.deliverables ?? [];
  const manifestMode = deliverables.length > 0;
  const coverageProbe = input.runCoverageProbe ?? defaultCoverageProbe;
  let coverageReport: CoverageReport | undefined;

  try {
    // Apply repro patch to baseline worktree.
    if (reproPatch.trim().length > 0) {
      await fs.writeFile(
        path.join(baselineIso.isolatedRoot, "__repro.patch"),
        reproPatch,
        "utf8",
      );
      // Use git apply to apply the repro patch to the baseline.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      try {
        await execFileAsync("git", ["apply", "--whitespace=nowarn", path.join(baselineIso.isolatedRoot, "__repro.patch")], {
          cwd: baselineIso.isolatedRoot,
        });
      } catch {
        // Patch apply failed on baseline — this is itself a red failure.
        redSummary = "repro patch failed to apply on baseline";
        redConfirmed = false;
      }
      // Don't leave the temp patch in the tree the baseline check inspects.
      await fs.rm(path.join(baselineIso.isolatedRoot, "__repro.patch"), { force: true });
    }

    // Manifest mode: prove every deliverable is covered AND red on baseline.
    if (!redSummary && manifestMode) {
      const testCommand = tdd.testCommand;
      if (!testCommand) {
        redSummary = "manifest coverage requires tdd.testCommand (none configured)";
        redConfirmed = false;
      } else {
        const probe = await coverageProbe({
          workspaceRoot: baselineIso.isolatedRoot,
          testCommand,
          signal: input.signal,
        });
        redRunId = probe.runId;
        if (probe.refused) {
          redSummary = "coverage test command was refused by the classifier";
          redConfirmed = false;
        } else {
          coverageReport = computeCoverage(deliverables, parseTapResults(probe.tap));
          if (coverageReport.complete) {
            redConfirmed = true;
            redSummary = `coverage complete: ${deliverables.length} deliverable(s) each covered by a red test`;
          } else {
            redConfirmed = false;
            const parts: string[] = [];
            if (coverageReport.uncovered.length > 0) {
              parts.push(`no failing test for: ${coverageReport.uncovered.join(", ")}`);
            }
            if (coverageReport.nonRed.length > 0) {
              parts.push(
                `test passes on baseline (vacuous/self-grading) for: ${coverageReport.nonRed.join(", ")}`,
              );
            }
            redSummary = `coverage incomplete — ${parts.join("; ")}`;
          }
        }
      }
    }

    // Run the baseline check to prove red (single-repro mode).
    if (!redSummary && !manifestMode) {
      const checkName = tdd.baselineCheckName ?? worker.checkName;
      const checkConfig = input.checks?.[checkName];
      if (checkConfig) {
        try {
          const checkRun = await runCheck(checkName, checkConfig, {
            workspaceRoot: baselineIso.isolatedRoot,
            signal: input.signal,
          });
          redRunId = checkRun.id;
          const failed = checkRun.exitCode !== 0 && !checkRun.timedOut;
          if (failed) {
            redConfirmed = true;
            redSummary = `baseline failed as expected (exit ${checkRun.exitCode})`;
          } else if (checkRun.timedOut) {
            redSummary = `baseline check timed out (exit ${checkRun.exitCode})`;
            redConfirmed = false;
          } else {
            redSummary = `baseline check passed unexpectedly (exit ${checkRun.exitCode}) — repro does not fail on baseline`;
            redConfirmed = false;
          }
          await saveTddCheckRun(input.realRoot, input.plan.id, worker.id, "red", checkRun, "");
        } catch (err) {
          const msg = err instanceof CheckRefusedError ? err.message : (err as Error).message;
          redSummary = `red check error: ${msg}`;
          redConfirmed = false;
        }
      } else {
        // No check config available — use spawn-based check.
        const checkResult = await spawnWorker({
          file: "node",
          args: ["--run", `--check=${checkName}`],
          cwd: baselineIso.isolatedRoot,
          env: parentEnv,
          signal: input.signal,
          timeoutMs: 120_000,
          maxCaptureBytes: 256_000,
          shell: false,
        });
        const failed = checkResult.exitCode !== 0 && !checkResult.timedOut;
        if (failed) {
          redConfirmed = true;
          redSummary = `baseline failed as expected (exit ${checkResult.exitCode})`;
        } else {
          redSummary = `baseline check exit ${checkResult.exitCode}${checkResult.timedOut ? " (timed out)" : ""}`;
          redConfirmed = false;
        }
      }
    }
  } finally {
    await cleanupIso(baselineIso);
  }

  if (!redConfirmed) {
    const tddRun: WorkerTddRun = {
      required: true,
      status: "red_failed",
      reproPaths,
      redRunId,
      warnings: [redSummary],
      coverage: coverageReport?.entries,
      coverageComplete: manifestMode ? false : undefined,
      uncoveredDeliverables: coverageReport?.uncovered,
      nonRedDeliverables: coverageReport?.nonRed,
    };
    await writeTddRecord(input.realRoot, input.plan.id, worker.id, tddRun);
    worker.status = "failed";
    await savePlan(input.realRoot, input.plan);

    return buildFailedTddResult(input, worker, startedAt, tddRun, null);
  }

  // ── Step 3: Fix Phase ────────────────────────────────────────────
  // Create a new worktree for the fix phase.
  const fixIso = await createIsolatedWorkspace(
    input.realRoot,
    input.isolationConfig ?? {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: "patch",
      provision: [],
    },
  );

  // Apply the repro patch first so the worker has the repro test.
  if (reproPatch.trim().length > 0) {
    await fs.writeFile(
      path.join(fixIso.isolatedRoot, "__repro.patch"),
      reproPatch,
      "utf8",
    );
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["apply", "--whitespace=nowarn", path.join(fixIso.isolatedRoot, "__repro.patch")], {
        cwd: fixIso.isolatedRoot,
      });
    } catch {
      // If repro patch doesn't apply cleanly, the fix phase may still work.
      warnings.push("repro patch did not apply cleanly to fix worktree");
    }
    // Remove the temp patch file so it does not pollute the fix-phase diff
    // (otherwise fix-patch validation rejects an out-of-scope "__repro.patch").
    await fs.rm(path.join(fixIso.isolatedRoot, "__repro.patch"), { force: true });
  }

  const fixPrompt = buildFixPhasePrompt(worker, input.plan, redSummary);
  const fixCmd = buildTddWorkerCommand(input.mainEntry, fixPrompt);

  let fixResult: BoundedProcessResult;
  try {
    fixResult = await spawnWorker({
      file: fixCmd.file,
      args: fixCmd.args,
      cwd: fixIso.isolatedRoot,
      env: buildTddWorkerEnv(parentEnv, input.provider, input.delegateDepth ?? 0),
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 30 * 60_000,
      maxCaptureBytes: 1_000_000,
      shell: false,
      onData: input.onData,
    });
  } catch (err) {
    await cleanupIso(fixIso);
    worker.status = "failed";
    await savePlan(input.realRoot, input.plan).catch(() => {});
    throw err;
  }

  const fixPatch = await fixIso.diff();

  // Validate fix patch against worker allowed paths.
  const fixValidation = validatePatch({
    patchText: fixPatch,
    allowedPaths: worker.allowedPaths,
    forbiddenPaths: worker.forbiddenPaths,
  });

  if (!fixValidation.ok) {
    await cleanupIso(fixIso);
    const tddRun: WorkerTddRun = {
      required: true,
      status: "green_failed",
      reproPaths,
      redRunId,
      warnings: fixValidation.failures.map((f) => f.message),
    };
    await writeTddRecord(input.realRoot, input.plan.id, worker.id, tddRun);
    worker.status = "failed";
    await savePlan(input.realRoot, input.plan);

    return buildFailedTddResult(input, worker, startedAt, tddRun, fixIso);
  }

  // Save fix patch.
  if (fixPatch.trim().length > 0) {
    await fs.writeFile(path.join(runDir, "fix.patch"), fixPatch, "utf8");
  }

  // ── Step 4: Green Proof ──────────────────────────────────────────
  let greenConfirmed = false;
  let greenRunId: string | undefined;
  // Phase 9M — in manifest mode the green proof re-runs the authored suite and
  // requires every (previously-red) deliverable to now pass.
  let greenCoverageComplete = !manifestMode; // single-repro mode: not applicable.

  const finalCheckName = tdd.finalCheckName ?? worker.checkName;
  const finalCheckConfig = input.checks?.[finalCheckName];

  if (manifestMode && tdd.testCommand) {
    const probe = await coverageProbe({
      workspaceRoot: fixIso.isolatedRoot,
      testCommand: tdd.testCommand,
      signal: input.signal,
    });
    greenRunId = probe.runId;
    if (probe.refused) {
      warnings.push("green coverage test command was refused by the classifier");
      greenConfirmed = false;
    } else {
      const notGreen = deliverablesNotGreen(deliverables, parseTapResults(probe.tap));
      greenCoverageComplete = notGreen.length === 0;
      greenConfirmed = probe.exitCode === 0 && greenCoverageComplete;
      if (!greenConfirmed && notGreen.length > 0) {
        warnings.push(`deliverables still not green: ${notGreen.join(", ")}`);
      }
    }
  } else if (finalCheckConfig) {
    try {
      const checkRun = await runCheck(finalCheckName, finalCheckConfig, {
        workspaceRoot: fixIso.isolatedRoot,
        signal: input.signal,
      });
      greenRunId = checkRun.id;
      greenConfirmed = checkRun.exitCode === 0 && !checkRun.timedOut;
      await saveTddCheckRun(input.realRoot, input.plan.id, worker.id, "green", checkRun, "");
    } catch (err) {
      const msg = err instanceof CheckRefusedError ? err.message : (err as Error).message;
      warnings.push(`green check error: ${msg}`);
      greenConfirmed = false;
    }
  } else {
    // No check config — use spawn-based check.
    const checkResult = await spawnWorker({
      file: "node",
      args: ["--run", `--check=${finalCheckName}`],
      cwd: fixIso.isolatedRoot,
      env: parentEnv,
      signal: input.signal,
      timeoutMs: 120_000,
      maxCaptureBytes: 256_000,
      shell: false,
    });
    greenConfirmed = checkResult.exitCode === 0 && !checkResult.timedOut;
  }

  // Build the final patch (combined repro + fix).
  const finalPatch = await fixIso.diff();
  const finalChangedFiles = await fixIso.changedFiles();
  const hasPatch = finalPatch.trim().length > 0;

  // Persist artifacts.
  let patchPath: string | null = null;
  if (hasPatch) {
    const patchAbs = path.join(runDir, "patch.diff");
    await fs.writeFile(patchAbs, finalPatch, "utf8");
    patchPath = path.relative(input.realRoot, patchAbs);
  }
  const patchSha256 = createHash("sha256").update(finalPatch).digest("hex");

  const checkPassed = greenConfirmed && hasPatch;
  if (!greenConfirmed) warnings.push("green check did not pass");
  if (!hasPatch) warnings.push("empty patch (worker produced no changes)");

  // Build TDD run record. In manifest mode, green_confirmed requires the full
  // coverage proof (every deliverable red-on-baseline then green-after-fix).
  const coverageComplete = manifestMode
    ? !!coverageReport?.complete && greenCoverageComplete
    : undefined;
  const manifestSatisfied = !manifestMode || coverageComplete === true;
  const tddStatus = checkPassed && manifestSatisfied ? "green_confirmed" : "green_failed";
  const tddRun: WorkerTddRun = {
    required: true,
    status: tddStatus,
    reproPaths,
    redRunId,
    greenRunId,
    redPatchPath: "repro.patch",
    fixPatchPath: hasPatch ? "fix.patch" : undefined,
    warnings,
    coverage: coverageReport?.entries,
    coverageComplete,
    uncoveredDeliverables: coverageReport?.uncovered,
    nonRedDeliverables: coverageReport?.nonRed,
  };
  await writeTddRecord(input.realRoot, input.plan.id, worker.id, tddRun);

  // Clean up fix worktree.
  await cleanupIso(fixIso);

  const isolation: WorkerIsolationRecord = {
    backend: "git-worktree",
    mode: "runner-owned",
    realRoot: input.realRoot,
    isolatedRoot: null,
    kept: false,
    cleaned: true,
  };

  const run: WorkerRun = {
    planId: input.plan.id,
    workerId: worker.id,
    sessionId: `tdd-${Date.now()}-${randomBytes(4).toString("hex")}`,
    worktreePath: "",
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: fixResult.exitCode,
    checkPassed,
    changedFiles: finalChangedFiles,
    patchPath: patchPath ?? "",
    patchSha256,
    summary: checkPassed
      ? `Worker ${worker.id} passed (TDD); ${finalChangedFiles.length} file(s) changed (not applied).`
      : `Worker ${worker.id} did not pass (TDD green=${greenConfirmed}).`,
    warnings,
    isolation,
    tdd: tddRun,
  };

  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");

  worker.status = checkPassed ? "passed" : "failed";
  await savePlan(input.realRoot, input.plan);

  return { run, patchPath, changedFiles: finalChangedFiles };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildTddWorkerCommand(mainEntry: string, prompt: string): { file: string; args: string[] } {
  return {
    file: process.execPath,
    args: [
      "--import",
      "tsx",
      mainEntry,
      "--solve",
      "--check",
      "phase",
      prompt,
    ],
  };
}

function buildTddWorkerEnv(
  parentEnv: NodeJS.ProcessEnv,
  provider: string,
  delegateDepth: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const ALLOWED_BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const ALLOWED_PROVIDER_ENV = [
    "DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_BASE_URL",
    "DEEPCODER_MODEL", "DEEPCODER_REASONER_MODEL", "DEEPCODER_PLAN_FIRST",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
  ];
  const OPENAI_COMPATIBLE = new Set(["openai", "openai-compatible"]);

  const copy = (key: string) => {
    const v = parentEnv[key];
    if (typeof v === "string") env[key] = v;
  };

  for (const k of ALLOWED_BASE_ENV) copy(k);
  for (const k of ALLOWED_PROVIDER_ENV) copy(k);
  if (OPENAI_COMPATIBLE.has(provider.toLowerCase())) copy("OPENAI_API_KEY");

  env.DEEPCODER_APPROVAL_MODE = "auto";
  env.DEEPCODER_WORKSPACE_ISOLATION = "off";
  env.NO_COLOR = "1";
  env.DEEPCODER_DELEGATE_DEPTH = String(delegateDepth + 1);

  return env;
}

async function cleanupIso(iso: { cleanup(): Promise<void> } | null): Promise<void> {
  if (!iso) return;
  try {
    await iso.cleanup();
  } catch {
    // Best-effort cleanup.
  }
}

function buildFailedTddResult(
  input: RunWorkerTddInput,
  worker: WorkerTask,
  startedAt: string,
  tddRun: WorkerTddRun,
  _iso: { cleanup(): Promise<void> } | null,
): RunWorkerResult {
  const run: WorkerRun = {
    planId: input.plan.id,
    workerId: worker.id,
    sessionId: `tdd-${Date.now()}-${randomBytes(4).toString("hex")}`,
    worktreePath: "",
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: null,
    checkPassed: false,
    changedFiles: [],
    patchPath: "",
    patchSha256: "",
    summary: `Worker ${worker.id} TDD failed: ${tddRun.status}`,
    warnings: tddRun.warnings,
    tdd: tddRun,
  };

  return { run, patchPath: null, changedFiles: [] };
}
