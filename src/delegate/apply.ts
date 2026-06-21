/**
 * Phase 9C — Apply/discard logic for delegated worker patches.
 *
 * This module is the ONLY place where a worker patch is applied to the real
 * repo. Every gate is fail-closed: if any precondition fails, nothing is
 * changed and a clear message is returned.
 *
 * Security properties:
 *   - Every plan-id / worker-id is validated via assertSafeId before use.
 *   - The patch is re-validated at apply time (defense in depth).
 *   - `git apply --check` is run before the real apply.
 *   - TTY gating: non-interactive sessions are refused.
 *   - Global checks are run after apply; failures are reported, not reverted.
 *   - An audit record is written after every apply or discard.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stdin } from "node:process";
import { assertSafeId } from "../workspace/paths.js";
import { loadPlan, savePlan } from "./store.js";
import { validatePatch } from "./patchValidator.js";
import { validateWorkerResult } from "./validation.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { confirm } from "../permissions/prompt.js";
import { readTddRecord } from "./tddArtifacts.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { WorkerRun, ApplyRecord } from "./types.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */

function runDir(root: string, planId: string, workerId: string): string {
  return path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
}

function patchPath(root: string, planId: string, workerId: string): string {
  return path.join(runDir(root, planId, workerId), "patch.diff");
}

function runJsonPath(root: string, planId: string, workerId: string): string {
  return path.join(runDir(root, planId, workerId), "run.json");
}

function applyJsonPath(root: string, planId: string, workerId: string): string {
  return path.join(runDir(root, planId, workerId), "apply.json");
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GlobalCheckResult {
  name: string;
  passed: boolean;
  summary: string;
}

export interface ApplyResult {
  ok: boolean;
  /** Human-readable message. */
  message: string;
  /** The audit record written, if any. */
  record?: ApplyRecord;
  /** Global check results, if any were run. */
  globalCheckResults?: GlobalCheckResult[];
}

export interface ApplyOptions {
  /**
   * Named checks available to satisfy the plan's `globalChecks` after apply.
   * Defaults to none (no global checks run).
   */
  checks?: Record<string, CheckConfig>;
  /** Override TTY detection (tests). Defaults to `stdin.isTTY`. */
  isTTY?: boolean;
  /** Override the interactive confirm result (tests). */
  confirmResult?: boolean;
  /** Paths already changed by previously-applied workers (overlap gate). */
  alreadyChangedPaths?: string[];
  /**
   * Phase 9J: when true, a passed worker must ALSO carry a non-blocked LLM
   * quality gate (run.qualityGate). A blocked gate is always refused; a missing
   * gate is refused only when this is set (mandatory mode).
   */
  requireQualityGate?: boolean;
  /** Phase 9L flip: require a validated (red→green) test (green_confirmed) to apply. */
  requireValidatedTest?: boolean;
}

/* ------------------------------------------------------------------ */
/*  applyWorker                                                        */
/* ------------------------------------------------------------------ */

/**
 * Apply a worker's patch to the real repo, following the full gate order. This
 * is the single, authoritative apply path — there is deliberately no second
 * "with/without checks" variant, so the gate sequence can never drift.
 *
 * Gate order (every step fail-closed):
 *   1. Load plan, find worker, load run.json and patch.diff.
 *   2. Refuse if the worker's check did not pass / status is not "passed".
 *   3. Re-validate the patch via validatePatch(...).
 *   4. `git apply --check --whitespace=nowarn` against the real repo root.
 *   5. TTY gate + confirm().
 *   6. `git apply --whitespace=nowarn` to the real repo root.
 *   7. Run the plan's globalChecks (if any) — failures are reported, not reverted.
 *   8. Write audit record, set worker.status = "applied", savePlan.
 */
export async function applyWorker(
  root: string,
  planId: string,
  workerId: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const checks = opts.checks ?? {};
  const alreadyChangedPaths = opts.alreadyChangedPaths ?? [];

  // Validate ids before any path construction.
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
  } catch {
    return { ok: false, message: `Invalid plan-id or worker-id.` };
  }

  // ── Gate 1: Load plan, worker, run.json, patch.diff ──────────────
  const plan = await loadPlan(root, planId);
  if (!plan) {
    return { ok: false, message: `Plan "${planId}" not found or corrupt.` };
  }

  const worker = plan.workers.find((w) => w.id === workerId);
  if (!worker) {
    return { ok: false, message: `Worker "${workerId}" not found in plan "${planId}".` };
  }

  let run: WorkerRun;
  try {
    const raw = await fs.readFile(runJsonPath(root, planId, workerId), "utf8");
    run = JSON.parse(raw) as WorkerRun;
  } catch {
    return { ok: false, message: `Run record for worker "${workerId}" not found or corrupt.` };
  }

  let patchText: string;
  try {
    patchText = await fs.readFile(patchPath(root, planId, workerId), "utf8");
  } catch {
    return { ok: false, message: `Patch file for worker "${workerId}" not found.` };
  }

  // ── Gate 1.5 (9K): Run the full validation pipeline ─────────────
  const validation = validateWorkerResult({
    root,
    plan,
    worker,
    run,
    patchText,
    alreadyChangedPaths,
    qualityGateRequired: opts.requireQualityGate ?? false,
    requireValidatedTest: opts.requireValidatedTest ?? false,
  });

  if (!validation.applyable) {
    const details = validation.failures
      .map((f) => `  [${f.code}]${f.path ? ` ${f.path}` : ""}: ${f.message}`)
      .join("\n");
    return {
      ok: false,
      message: `Validation failed for worker "${workerId}":\n${details}`,
    };
  }

  // ── Gate 2: Check must have passed ───────────────────────────────
  if (!run.checkPassed) {
    return {
      ok: false,
      message: `Worker "${workerId}" check did not pass (checkPassed=${run.checkPassed}). A failed-check worker can never be applied.`,
    };
  }
  if (worker.status !== "passed") {
    return {
      ok: false,
      message: `Worker "${workerId}" status is "${worker.status}", not "passed". Only passed workers can be applied.`,
    };
  }

  // ── Gate 3: Re-validate the patch ────────────────────────────────
  const patchVal = validatePatch({
    patchText,
    allowedPaths: worker.allowedPaths,
    forbiddenPaths: worker.forbiddenPaths,
    alreadyChangedPaths,
  });
  if (!patchVal.ok) {
    const details = patchVal.failures
      .map((f) => `  [${f.code}]${f.path ? ` ${f.path}` : ""}: ${f.message}`)
      .join("\n");
    return {
      ok: false,
      message: `Patch validation failed for worker "${workerId}":\n${details}`,
    };
  }

  // ── Gate 3.5 (9J): LLM quality gate — downgrade-only, after deterministic ──
  // A blocked gate is ALWAYS refused; a missing gate is refused only in
  // mandatory mode. The reviewer can never turn a deterministic pass into an
  // apply on its own — it can only block here.
  const qg = run.qualityGate;
  const qgObj = qg && typeof qg === "object" ? qg : undefined;
  if (qgObj?.blocked) {
    const top = qgObj.findings.find((f) => f.severity === "critical" || f.severity === "high") ?? qgObj.findings[0];
    const detail = top ? `${top.severity} finding: ${top.claim}${top.path ? ` (${top.path})` : ""}` : (qgObj.errors[0] ?? "blocked");
    return { ok: false, message: `Quality gate blocked worker "${workerId}": ${detail}` };
  }
  if (opts.requireQualityGate && !qgObj) {
    return {
      ok: false,
      message: `Quality gate required but missing for worker "${workerId}". Run /delegate review ${planId} ${workerId} --quality, or rerun the worker.`,
    };
  }

  // ── Gate 3.75 (9L): TDD gate — refuse if TDD-required without green_confirmed ──
  if (worker.tdd?.required) {
    const tddRec = await readTddRecord(root, planId, workerId);
    if (!tddRec) {
      return {
        ok: false,
        message: `TDD-required worker "${workerId}" has no TDD record. Run the worker with TDD enabled first.`,
      };
    }
    if (tddRec.status !== "green_confirmed" && tddRec.status !== "waived") {
      return {
        ok: false,
        message: `TDD-required worker "${workerId}" has status "${tddRec.status}", not "green_confirmed". Red/green proof is required before apply.`,
      };
    }
  }

  // ── Gate 4: git apply --check ────────────────────────────────────
  try {
    await execFileAsync("git", [
      "apply", "--check", "--whitespace=nowarn",
      patchPath(root, planId, workerId),
    ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    return {
      ok: false,
      message: `git apply --check failed for worker "${workerId}": ${e.stderr?.trim() || `exit code ${e.code ?? "?"}`}. The repo may have moved under the patch.`,
    };
  }

  // ── Gate 5: TTY gate + confirm ───────────────────────────────────
  const tty = opts.isTTY ?? stdin.isTTY;
  if (!tty) {
    return {
      ok: false,
      message: `Non-interactive session: refusing to apply. Patch saved at: ${patchPath(root, planId, workerId)}`,
    };
  }

  const approved = opts.confirmResult ?? (await confirm(
    `Apply patch for worker "${workerId}" (${patchVal.changedPaths.length} file(s))?`,
  ));
  if (!approved) {
    return { ok: false, message: `Apply cancelled by user.` };
  }

  // ── Gate 6: git apply ────────────────────────────────────────────
  try {
    await execFileAsync("git", [
      "apply", "--whitespace=nowarn",
      patchPath(root, planId, workerId),
    ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    return {
      ok: false,
      message: `git apply failed for worker "${workerId}": ${e.stderr?.trim() || `exit code ${e.code ?? "?"}`}.`,
    };
  }

  // ── Gate 7: Run global checks (failures reported, not reverted) ───
  const globalCheckResults: GlobalCheckResult[] = [];
  for (const checkName of plan.globalChecks) {
    const checkConfig = checks[checkName];
    if (!checkConfig) {
      globalCheckResults.push({
        name: checkName,
        passed: false,
        summary: `Check "${checkName}" not found in config.`,
      });
      continue;
    }
    try {
      const result = await runCheck(checkName, checkConfig, {
        workspaceRoot: root,
        signal: new AbortController().signal,
      });
      const passed = result.exitCode === 0 && !result.timedOut;
      globalCheckResults.push({
        name: checkName,
        passed,
        summary: passed
          ? `passed (exit 0, ${result.durationMs}ms)`
          : `failed (exit ${result.exitCode ?? "?"}${result.timedOut ? ", timed out" : ""}, ${result.durationMs}ms)`,
      });
    } catch (err) {
      const msg = err instanceof CheckRefusedError ? err.message : (err as Error).message;
      globalCheckResults.push({ name: checkName, passed: false, summary: `check error: ${msg}` });
    }
  }

  // ── Gate 8: Write audit record, update status ────────────────────
  const patchSha256 = createHash("sha256").update(patchText).digest("hex");
  const record: ApplyRecord = {
    planId,
    workerId,
    action: "applied",
    appliedAt: new Date().toISOString(),
    patchSha256,
    globalCheckResults: globalCheckResults.length > 0 ? globalCheckResults : undefined,
  };

  await fs.mkdir(runDir(root, planId, workerId), { recursive: true });
  await fs.writeFile(applyJsonPath(root, planId, workerId), JSON.stringify(record, null, 2), "utf8");

  worker.status = "applied";
  await savePlan(root, plan);

  const checksFailed = globalCheckResults.filter((g) => !g.passed);
  const note = checksFailed.length
    ? ` Warning: ${checksFailed.length} global check(s) failed AFTER apply — review and revert manually if needed.`
    : "";

  return {
    ok: true,
    message: `Applied patch for worker "${workerId}" (${patchVal.changedPaths.length} file(s)).${note}`,
    record,
    globalCheckResults: globalCheckResults.length > 0 ? globalCheckResults : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  discardWorker                                                      */
/* ------------------------------------------------------------------ */

/**
 * Discard a worker: set its status to "discarded" and write an audit record.
 * Never touches the real repo or any real files.
 */
export async function discardWorker(
  root: string,
  planId: string,
  workerId: string,
): Promise<ApplyResult> {
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
  } catch {
    return { ok: false, message: `Invalid plan-id or worker-id.` };
  }

  const plan = await loadPlan(root, planId);
  if (!plan) {
    return { ok: false, message: `Plan "${planId}" not found or corrupt.` };
  }

  const worker = plan.workers.find((w) => w.id === workerId);
  if (!worker) {
    return { ok: false, message: `Worker "${workerId}" not found in plan "${planId}".` };
  }

  const record: ApplyRecord = {
    planId,
    workerId,
    action: "discarded",
    appliedAt: new Date().toISOString(),
    patchSha256: "",
  };

  await fs.mkdir(runDir(root, planId, workerId), { recursive: true });
  await fs.writeFile(applyJsonPath(root, planId, workerId), JSON.stringify(record, null, 2), "utf8");

  worker.status = "discarded";
  await savePlan(root, plan);

  // Optionally surface the patch path (read-only; the repo is never touched).
  const pp = patchPath(root, planId, workerId);
  let message = `Worker "${workerId}" discarded.`;
  try {
    await fs.access(pp);
    message += ` Patch at: ${pp}`;
  } catch {
    // No patch file — that's fine.
  }

  return { ok: true, message, record };
}
