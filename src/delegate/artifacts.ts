import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import { redactSecrets } from "../workspace/redact.js";
import { loadPlan } from "./store.js";
import type { DelegationPlan, WorkerRun, ApplyRecord } from "./types.js";

export interface ArtifactsLoadResult {
  plan: DelegationPlan | null;
  run: WorkerRun | null;
  patchText: string | null;
  patchPreview: string | null;
  telemetryPreview: string | null;
  qualityArtifact: string | null;
  applyRecord: ApplyRecord | null;
  runLogPreview: string | null;
  warnings: string[];
  artifactPaths: Record<string, string>;
}

export interface LoadArtifactsOptions {
  patchPreviewBytes?: number;
  logTailBytes?: number;
  telemetryBytes?: number;
}

function runDir(root: string, planId: string, workerId: string): string {
  return path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
}

async function safeReadFile(p: string, maxBytes?: number, tail?: boolean): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return null;
    
    if (maxBytes !== undefined && stat.size > maxBytes) {
      const fd = await fs.open(p, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        if (tail) {
          const pos = Math.max(0, stat.size - maxBytes);
          await fd.read(buf, 0, maxBytes, pos);
          return redactSecrets(buf.toString("utf8"));
        } else {
          await fd.read(buf, 0, maxBytes, 0);
          return redactSecrets(buf.toString("utf8"));
        }
      } finally {
        await fd.close();
      }
    }
    
    const content = await fs.readFile(p, "utf8");
    return redactSecrets(content);
  } catch {
    return null;
  }
}

export async function loadWorkerArtifacts(
  root: string,
  planId: string,
  workerId: string,
  opts: LoadArtifactsOptions = {}
): Promise<ArtifactsLoadResult> {
  const warnings: string[] = [];
  const artifactPaths: Record<string, string> = {};
  
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
  } catch (err) {
    warnings.push(`Invalid planId or workerId: ${(err as Error).message}`);
    return {
      plan: null, run: null, patchText: null, patchPreview: null,
      telemetryPreview: null, qualityArtifact: null, applyRecord: null,
      runLogPreview: null, warnings, artifactPaths
    };
  }

  const dir = runDir(root, planId, workerId);
  
  const plan = await loadPlan(root, planId);
  if (!plan) {
    warnings.push(`Plan "${planId}" not found or corrupt.`);
  }

  const runJsonPath = path.join(dir, "run.json");
  let run: WorkerRun | null = null;
  try {
    const raw = await fs.readFile(runJsonPath, "utf8");
    run = JSON.parse(raw) as WorkerRun;
    artifactPaths["run.json"] = runJsonPath;
  } catch {
    warnings.push(`Run record for worker "${workerId}" not found or corrupt.`);
  }

  const patchPath = path.join(dir, "patch.diff");
  let patchText: string | null = null;
  let patchPreview: string | null = null;
  try {
    patchText = await fs.readFile(patchPath, "utf8");
    patchText = redactSecrets(patchText);
    artifactPaths["patch.diff"] = patchPath;
    
    const maxPatch = opts.patchPreviewBytes ?? 80 * 1024;
    if (Buffer.byteLength(patchText, "utf8") > maxPatch) {
      patchPreview = Buffer.from(patchText, "utf8").subarray(0, maxPatch).toString("utf8") + "\n... (truncated)";
    } else {
      patchPreview = patchText;
    }
  } catch {
    warnings.push(`Patch file for worker "${workerId}" not found.`);
  }

  const applyJsonPath = path.join(dir, "apply.json");
  let applyRecord: ApplyRecord | null = null;
  try {
    const raw = await fs.readFile(applyJsonPath, "utf8");
    applyRecord = JSON.parse(raw) as ApplyRecord;
    artifactPaths["apply.json"] = applyJsonPath;
  } catch {
    // apply.json is optional
  }

  let telemetryPreview: string | null = null;
  if (run?.telemetryPath) {
    const telPath = path.resolve(root, run.telemetryPath);
    telemetryPreview = await safeReadFile(telPath, opts.telemetryBytes ?? 40 * 1024);
    if (telemetryPreview) {
      artifactPaths["telemetry.json"] = telPath;
    }
  }

  let qualityArtifact: string | null = null;
  if (run?.qualityGate && typeof run.qualityGate === "object" && run.qualityGate.artifactPath) {
    const qPath = path.resolve(root, run.qualityGate.artifactPath);
    qualityArtifact = await safeReadFile(qPath, opts.telemetryBytes ?? 40 * 1024);
    if (qualityArtifact) {
      artifactPaths["quality.json"] = qPath;
    }
  }

  const logPath = path.join(dir, "run.log");
  const runLogPreview = await safeReadFile(logPath, opts.logTailBytes ?? 40 * 1024, true);
  if (runLogPreview) {
    artifactPaths["run.log"] = logPath;
  }

  return {
    plan,
    run,
    patchText,
    patchPreview,
    telemetryPreview,
    qualityArtifact,
    applyRecord,
    runLogPreview,
    warnings,
    artifactPaths
  };
}
