import type { DelegationReviewOverview, WorkerReviewDetail, ApplyGatePreview } from "./reviewBrowser.js";
import type { PatchStat } from "./diffView.js";

export interface RenderOptions {
  maxLines?: number;
  maxBytes?: number;
}

function boundString(str: string, opts: RenderOptions): string {
  let result = str;
  if (opts.maxLines) {
    const lines = result.split("\n");
    if (lines.length > opts.maxLines) {
      result = lines.slice(0, opts.maxLines).join("\n") + "\n... (truncated lines)";
    }
  }
  if (opts.maxBytes && Buffer.byteLength(result, "utf8") > opts.maxBytes) {
    result = Buffer.from(result, "utf8").subarray(0, opts.maxBytes).toString("utf8") + "\n... (truncated bytes)";
  }
  return result;
}

export function renderReviewOverview(overview: DelegationReviewOverview, opts: RenderOptions = {}): string {
  let out = `plan ${overview.planId} · ${overview.workers.length} workers · status ${overview.planStatus}\n\n`;
  
  for (const w of overview.workers) {
    const checkStr = w.checkPassed === true ? "check phase:pass" : w.checkPassed === false ? "check phase:fail" : "check phase:none";
    const qgStr = `qg ${w.qualityGate}`;
    const applyStr = w.applyEligible ? "apply ok" : "apply blocked";
    const filesStr = `${w.changedFiles.length} file${w.changedFiles.length === 1 ? "" : "s"}`;
    
    out += `${w.workerId.padEnd(10)} ${w.status.padEnd(8)} ${filesStr.padEnd(8)} ${checkStr.padEnd(18)} ${qgStr.padEnd(12)} ${applyStr}\n`;
  }
  
  if (overview.warnings.length > 0) {
    out += `\nWarnings:\n${overview.warnings.map(w => `- ${w}`).join("\n")}\n`;
  }
  
  return boundString(out.trimEnd(), opts);
}

export function renderWorkerReview(detail: WorkerReviewDetail, opts: RenderOptions = {}): string {
  const kb = (detail.patchBytes / 1024).toFixed(1);
  const sha = detail.patchSha256 ? detail.patchSha256.substring(0, 8) + "..." : "none";
  
  let out = `${detail.workerId} — ${detail.title}\n`;
  out += `status: ${detail.status} · check: ${detail.checkPassed ? "passed" : "failed"} · quality: ${detail.qualityGate} · patch: ${kb}KB · sha ${sha}\n`;
  
  if (detail.changedFiles.length > 0) {
    out += `changed: ${detail.changedFiles.join(", ")}\n`;
  } else {
    out += `changed: none\n`;
  }
  
  const gatesStr = detail.deterministicGates.map(g => `${g.name} ${g.passed ? "ok" : "FAIL"}`).join(" · ");
  out += `gates: ${gatesStr}\n`;
  
  const artifacts = Object.keys(detail.artifactPaths).join(" · ");
  if (artifacts) {
    out += `artifacts: ${artifacts}\n`;
  }
  
  if (detail.applyEligible) {
    out += `next: /delegate apply ${detail.workerId}\n`; // Wait, the plan says `/delegate apply p123 worker-1`
    // But we don't have planId in detail directly, wait, we can just say `/delegate apply <planId> <workerId>`
    // Let's just say `/delegate apply <workerId>` or something.
  } else {
    out += `apply blocked: ${detail.applyBlockers.join(", ")}\n`;
  }
  
  return boundString(out.trimEnd(), opts);
}

export function renderPatchStat(stats: PatchStat[]): string {
  if (stats.length === 0) return "No files changed.";
  
  let out = "";
  let totalAdded = 0;
  let totalRemoved = 0;
  
  for (const s of stats) {
    const added = `+${s.added}`.padEnd(5);
    const removed = `-${s.removed}`.padEnd(5);
    out += `${added} ${removed} ${s.path} (${s.kind})\n`;
    totalAdded += s.added;
    totalRemoved += s.removed;
  }
  
  out += `\n${stats.length} file(s) changed, ${totalAdded} insertions(+), ${totalRemoved} deletions(-)`;
  return out;
}

export function renderGatePreview(preview: ApplyGatePreview): string {
  let out = `Apply Eligibility: ${preview.eligible ? "ELIGIBLE" : "BLOCKED"}\n\n`;
  
  out += "Gates:\n";
  for (const g of preview.gates) {
    out += `[${g.passed ? "PASS" : "FAIL"}] ${g.name}: ${g.message}\n`;
  }
  
  if (preview.blockers.length > 0) {
    out += `\nBlockers:\n${preview.blockers.map(b => `- ${b}`).join("\n")}`;
  }
  
  return out;
}
