import { applyWorker, type ApplyResult } from "./apply.js";
import type { CheckConfig } from "../config/fileConfig.js";
import { validatePatch } from "./patchValidator.js";
import { loadPlan } from "./store.js";
import { assertSafeId } from "../workspace/paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerRun } from "./types.js";

export interface AutoApplyOptions {
  autoApply: boolean;            // explicit enable; FALSE means never apply
  maxPatchBytes?: number;        // default 200_000
  checks?: Record<string, CheckConfig>;
  alreadyChangedPaths?: string[];
  /** Acceptance-first: require a validated red→green test before applying. */
  requireValidatedTest?: boolean;
}
export interface AutoApplyResult { applied: boolean; reason: string; result?: ApplyResult; }

export async function autoApplyIfEligible(root: string, planId: string, workerId: string, opts: AutoApplyOptions): Promise<AutoApplyResult> {
  // 1. opts.autoApply !== true  -> reason "auto-apply is not enabled".
  if (opts.autoApply !== true) {
    return { applied: false, reason: "auto-apply is not enabled" };
  }

  // 2. assertSafeId(planId)/(workerId); loadPlan; plan must have EXACTLY ONE worker -> else "auto-apply requires a single-worker plan".
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
  } catch (e: any) {
    return { applied: false, reason: `Invalid planId or workerId: ${e.message}` };
  }

  const plan = await loadPlan(root, planId);
  if (!plan) {
    return { applied: false, reason: `Plan ${planId} not found or corrupt.` };
  }
  if (plan.workers.length !== 1 || plan.workers[0]?.id !== workerId) {
    return { applied: false, reason: "auto-apply requires a single-worker plan" };
  }

  // 3. find the worker; load its run.json; run.checkPassed must be true -> else "worker check did not pass".
  const worker = plan.workers.find((w) => w.id === workerId);
  if (!worker) {
    return { applied: false, reason: `Worker ${workerId} not found in plan ${planId}` };
  }

  const runPath = join(root, ".deepcoder", "delegations", planId, "runs", workerId, "run.json");
  let workerRun: WorkerRun;
  try {
    const rawRun = readFileSync(runPath, "utf-8");
    workerRun = JSON.parse(rawRun) as WorkerRun;
  } catch (e: any) {
    return { applied: false, reason: `Failed to read worker run file: ${e.message}` };
  }

  if (!workerRun.checkPassed) {
    return { applied: false, reason: "worker check did not pass" };
  }

  // 4. read patch.diff (.deepcoder/delegations/<plan>/runs/<worker>/patch.diff); Buffer.byteLength(patch) <= (maxPatchBytes ?? 200_000) -> else "patch too large".
  const patchPath = join(root, ".deepcoder", "delegations", planId, "runs", workerId, "patch.diff");
  let patchContent: string;
  try {
    patchContent = readFileSync(patchPath, "utf-8");
  } catch (e: any) {
    return { applied: false, reason: `Failed to read patch file: ${e.message}` };
  }

  const maxPatchBytes = opts.maxPatchBytes ?? 200_000;
  if (Buffer.byteLength(patchContent) > maxPatchBytes) {
    return { applied: false, reason: `patch too large (${Buffer.byteLength(patchContent)} bytes > ${maxPatchBytes} bytes)` };
  }

  // 5. validatePatch (from src/delegate/patchValidator.js) with the worker's allowedPaths/forbiddenPaths + alreadyChangedPaths must pass (no out_of_scope/forbidden/sensitive/generated/overlap) -> else "patch failed validation: <codes>".
  const validationResult = validatePatch({
    patchText: patchContent,
    allowedPaths: worker.allowedPaths,
    forbiddenPaths: worker.forbiddenPaths,
    alreadyChangedPaths: opts.alreadyChangedPaths,
  });

  if (!validationResult.ok) {
    return { applied: false, reason: `patch failed validation: ${validationResult.failures.map((f) => f.code).join(", ")}` };
  }

  // 6. ALL passed -> call applyWorker(root, planId, workerId, { checks: opts.checks, isTTY: true, confirmResult: true, alreadyChangedPaths: opts.alreadyChangedPaths }). Return { applied: result.ok, reason: result.message, result }.
  const applyResult = await applyWorker(root, planId, workerId, {
    checks: opts.checks,
    isTTY: true,
    confirmResult: true,
    alreadyChangedPaths: opts.alreadyChangedPaths,
    requireValidatedTest: opts.requireValidatedTest ?? false,
  });

  return { applied: applyResult.ok, reason: applyResult.message, result: applyResult };
}
