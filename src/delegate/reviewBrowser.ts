import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadWorkerArtifacts } from "./artifacts.js";
import { validatePatch } from "./patchValidator.js";
import { readTddRecord } from "./tddArtifacts.js";
import { computePatchStat } from "./diffView.js";
import type { PatchStat } from "./diffView.js";
import type { CheckConfig } from "../config/fileConfig.js";

const execFileAsync = promisify(execFile);

export interface GateSummary {
  name: string;
  passed: boolean;
  message: string;
}

export interface WorkerReviewSummary {
  workerId: string;
  title: string;
  status: string;
  checkPassed: boolean | null;
  changedFiles: string[];
  patchBytes: number;
  patchSha256?: string;
  qualityGate: "pass" | "blocked" | "missing" | "skipped";
  deterministicGates: GateSummary[];
  applyEligible: boolean;
  applyBlockers: string[];
}

export interface DelegationReviewOverview {
  planId: string;
  planStatus: string;
  task: string;
  workers: WorkerReviewSummary[];
  warnings: string[];
}

export interface WorkerReviewDetail extends WorkerReviewSummary {
  promptPreview: string;
  summary: string;
  patchStat: PatchStat[];
  patchPreview: string;
  runLogPreview?: string;
  telemetryPreview?: unknown;
  artifactPaths: Record<string, string>;
}

export interface ApplyGatePreview {
  eligible: boolean;
  blockers: string[];
  gates: GateSummary[];
}

export interface PreviewApplyGatesOptions {
  runGitCheck?: boolean;
  requireQualityGate?: boolean;
  requireValidatedTest?: boolean;
  alreadyChangedPaths?: string[];
  checks?: Record<string, CheckConfig>;
}

export async function previewApplyGates(
  root: string,
  planId: string,
  workerId: string,
  opts: PreviewApplyGatesOptions = {}
): Promise<ApplyGatePreview> {
  const gates: GateSummary[] = [];
  const blockers: string[] = [];

  const artifacts = await loadWorkerArtifacts(root, planId, workerId);
  const { plan, run, patchText } = artifacts;

  if (!plan) {
    gates.push({ name: "plan_exists", passed: false, message: "Plan not found or corrupt." });
    blockers.push("Plan not found or corrupt.");
    return { eligible: false, blockers, gates };
  }

  const worker = plan.workers.find((w) => w.id === workerId);
  if (!worker) {
    gates.push({ name: "worker_exists", passed: false, message: `Worker ${workerId} not found in plan.` });
    blockers.push(`Worker ${workerId} not found in plan.`);
    return { eligible: false, blockers, gates };
  }

  // 1. Worker status is passed
  const statusPassed = worker.status === "passed";
  gates.push({
    name: "worker_status",
    passed: statusPassed,
    message: statusPassed ? "Worker status is passed." : `Worker status is ${worker.status}.`
  });
  if (!statusPassed) blockers.push(`Worker status is ${worker.status}, not passed.`);

  // 2. Run record exists
  const runExists = !!run;
  gates.push({
    name: "run_exists",
    passed: runExists,
    message: runExists ? "Run record exists." : "Run record missing."
  });
  if (!runExists) blockers.push("Run record missing.");

  // 3. run.checkPassed === true
  const checkPassed = run?.checkPassed === true;
  gates.push({
    name: "check_passed",
    passed: checkPassed,
    message: checkPassed ? "Check passed." : "Check did not pass."
  });
  if (!checkPassed) blockers.push("Check did not pass.");

  // 4. Patch exists and is non-empty
  const patchExists = !!patchText && patchText.trim().length > 0;
  gates.push({
    name: "patch_exists",
    passed: patchExists,
    message: patchExists ? "Patch exists and is non-empty." : "Patch is missing or empty."
  });
  if (!patchExists) blockers.push("Patch is missing or empty.");

  // 5. validatePatch passes using worker scope
  if (patchText) {
    const patchVal = validatePatch({
      patchText,
      allowedPaths: worker.allowedPaths,
      forbiddenPaths: worker.forbiddenPaths,
      alreadyChangedPaths: opts.alreadyChangedPaths ?? []
    });
    gates.push({
      name: "patch_scope",
      passed: patchVal.ok,
      message: patchVal.ok ? "Patch scope is valid." : `Patch validation failed: ${patchVal.failures.map(f => f.message).join(", ")}`
    });
    if (!patchVal.ok) blockers.push(`Patch validation failed: ${patchVal.failures.map(f => f.message).join(", ")}`);
  } else {
    gates.push({ name: "patch_scope", passed: false, message: "Cannot validate missing patch." });
  }

  // 6 & 7. Quality gate
  const qg = run?.qualityGate;
  const qgObj = qg && typeof qg === "object" ? qg : undefined;
  const qgBlocked = qgObj?.blocked === true;
  const qgMissing = opts.requireQualityGate && !qgObj;
  
  gates.push({
    name: "quality_gate",
    passed: !qgBlocked && !qgMissing,
    message: qgBlocked ? "Quality gate blocked." : qgMissing ? "Quality gate required but missing." : "Quality gate ok."
  });
  if (qgBlocked) blockers.push("Quality gate blocked.");
  if (qgMissing) blockers.push("Quality gate required but missing.");

  // TDD gate
  if (worker.tdd?.required) {
    const tddRec = await readTddRecord(root, planId, workerId);
    const tddOk = tddRec && (tddRec.status === "green_confirmed" || tddRec.status === "waived");
    gates.push({
      name: "tdd_gate",
      passed: !!tddOk,
      message: tddOk ? "TDD gate passed." : "TDD gate failed or missing."
    });
    if (!tddOk) blockers.push("TDD gate failed or missing.");
  }

  // 8. git apply --check
  if (opts.runGitCheck && patchText) {
    const patchPath = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId, "patch.diff");
    try {
      await execFileAsync("git", [
        "apply", "--check", "--whitespace=nowarn", patchPath
      ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
      gates.push({ name: "git_apply_check", passed: true, message: "git apply --check passed." });
    } catch (err) {
      const e = err as { stderr?: string; code?: number };
      const msg = e.stderr?.trim() || `exit code ${e.code ?? "?"}`;
      gates.push({ name: "git_apply_check", passed: false, message: `git apply --check failed: ${msg}` });
      blockers.push(`git apply --check failed: ${msg}`);
    }
  } else {
    gates.push({ name: "git_apply_check", passed: true, message: "not checked" });
  }

  // 9. Dependencies already applied
  const depsOk = worker.dependsOn.every(depId => {
    const dep = plan.workers.find(w => w.id === depId);
    return dep && dep.status === "applied";
  });
  gates.push({
    name: "dependencies",
    passed: depsOk,
    message: depsOk ? "Dependencies applied." : "Dependencies not applied."
  });
  if (!depsOk) blockers.push("Dependencies not applied.");

  // 10. Global check names exist in config
  const checks = opts.checks ?? {};
  const globalChecksOk = plan.globalChecks.every(c => !!checks[c]);
  gates.push({
    name: "global_checks",
    passed: globalChecksOk,
    message: globalChecksOk ? "Global checks exist." : "Global checks missing from config."
  });
  if (!globalChecksOk) blockers.push("Global checks missing from config.");

  return {
    eligible: blockers.length === 0,
    blockers,
    gates
  };
}

export async function getWorkerReviewSummary(
  root: string,
  planId: string,
  workerId: string,
  opts: PreviewApplyGatesOptions = {}
): Promise<WorkerReviewSummary | null> {
  const artifacts = await loadWorkerArtifacts(root, planId, workerId);
  const { plan, run, patchText } = artifacts;
  
  if (!plan) return null;
  const worker = plan.workers.find(w => w.id === workerId);
  if (!worker) return null;

  const gatePreview = await previewApplyGates(root, planId, workerId, opts);
  
  let qgStatus: "pass" | "blocked" | "missing" | "skipped" = "missing";
  if (run?.qualityGate === "skipped_deterministic_failure") {
    qgStatus = "skipped";
  } else if (run?.qualityGate && typeof run.qualityGate === "object") {
    qgStatus = run.qualityGate.blocked ? "blocked" : "pass";
  }

  return {
    workerId,
    title: worker.title,
    status: worker.status,
    checkPassed: run ? run.checkPassed : null,
    changedFiles: run?.changedFiles ?? [],
    patchBytes: patchText ? Buffer.byteLength(patchText, "utf8") : 0,
    patchSha256: run?.patchSha256,
    qualityGate: qgStatus,
    deterministicGates: gatePreview.gates,
    applyEligible: gatePreview.eligible,
    applyBlockers: gatePreview.blockers
  };
}

export async function getDelegationReviewOverview(
  root: string,
  planId: string,
  opts: PreviewApplyGatesOptions = {}
): Promise<DelegationReviewOverview | null> {
  const artifacts = await loadWorkerArtifacts(root, planId, "dummy");
  const { plan } = artifacts;
  if (!plan) return null;

  const workers: WorkerReviewSummary[] = [];
  for (const w of plan.workers) {
    const summary = await getWorkerReviewSummary(root, planId, w.id, opts);
    if (summary) workers.push(summary);
  }

  return {
    planId,
    planStatus: plan.status,
    task: plan.task,
    workers,
    warnings: artifacts.warnings.filter(w => !w.includes("dummy"))
  };
}

export async function getWorkerReviewDetail(
  root: string,
  planId: string,
  workerId: string,
  opts: PreviewApplyGatesOptions = {}
): Promise<WorkerReviewDetail | null> {
  const summary = await getWorkerReviewSummary(root, planId, workerId, opts);
  if (!summary) return null;

  const artifacts = await loadWorkerArtifacts(root, planId, workerId);
  const { plan, run, patchText, patchPreview, runLogPreview, telemetryPreview, artifactPaths } = artifacts;
  
  const worker = plan!.workers.find(w => w.id === workerId)!;
  
  let telemetryObj: unknown = undefined;
  if (telemetryPreview) {
    try {
      telemetryObj = JSON.parse(telemetryPreview);
    } catch {
      telemetryObj = telemetryPreview;
    }
  }

  return {
    ...summary,
    promptPreview: worker.prompt.length > 200 ? worker.prompt.substring(0, 200) + "..." : worker.prompt,
    summary: run?.summary ?? "No run summary available.",
    patchStat: patchText ? computePatchStat(patchText) : [],
    patchPreview: patchPreview ?? "No patch available.",
    runLogPreview: runLogPreview ?? undefined,
    telemetryPreview: telemetryObj,
    artifactPaths
  };
}
