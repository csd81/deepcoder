import type { SubagentFinding, SubagentResult, RunSubagentOptions } from "../subagents/types.js";
import { reviewer } from "../subagents/profiles.js";
import { runSubagent } from "../subagents/runner.js";
import { verifyFindings } from "./verifyFindings.js";

export const REVIEW_ANGLES_HIGH = [
  { id: "correctness-control", lens: "Focus ONLY on control-flow correctness: inverted conditions, off-by-one, wrong branch, early return." },
  { id: "correctness-data",    lens: "Focus ONLY on data correctness: null/undefined deref, wrong-variable copy-paste, falsy-zero checks, type coercion." },
  { id: "correctness-async",   lens: "Focus ONLY on async/error correctness: missing await, unhandled rejection, error swallowed in catch, removed guard." },
  { id: "cleanup-dup",         lens: "Focus ONLY on code duplicating an existing helper (a concrete failure if they drift)." },
  { id: "cleanup-dead",        lens: "Focus ONLY on dead/unreachable code the change leaves behind." },
  { id: "cleanup-resource",    lens: "Focus ONLY on leaked/unreleased resources (handles, listeners, locks)." },
  { id: "altitude",            lens: "Focus ONLY on whether the change solves the problem at the right layer; flag concrete defects only." },
  { id: "conventions",         lens: "Focus ONLY on violated invariants/contracts in THIS codebase that cause a concrete failure." },
] as const;

export interface MultiAngleReviewDeps {
  runSubagent: typeof runSubagent;
  verifyFindings: typeof verifyFindings;
  opts: RunSubagentOptions;
}

export function dedupFindings(findings: SubagentFinding[]): SubagentFinding[] {
  const fileLineMap = new Map<string, SubagentFinding>();
  const fileless: SubagentFinding[] = [];

  for (const f of findings) {
    if (!f.file) {
      fileless.push(f);
      continue;
    }
    const key = `${f.file}:${f.line ?? ""}`;
    const existing = fileLineMap.get(key);
    if (!existing) {
      fileLineMap.set(key, { ...f });
      continue;
    }
    
    // Merge existing and f
    const severities = { critical: 4, high: 3, medium: 2, low: 1 };
    const existingSeverity = severities[existing.severity as keyof typeof severities] || 1;
    const fSeverity = severities[f.severity as keyof typeof severities] || 1;
    
    const maxSeverity = fSeverity > existingSeverity ? f.severity : existing.severity;
    existing.severity = maxSeverity;
    
    if (f.claim !== existing.claim) {
      existing.claim = `${existing.claim} | ${f.claim}`;
    }
    if (f.evidence !== existing.evidence) {
      existing.evidence = `${existing.evidence} | ${f.evidence}`;
    }
  }

  return [...fileLineMap.values(), ...fileless];
}

export async function runMultiAngleReview(
  baseTask: string,
  effort: "low" | "high",
  deps: MultiAngleReviewDeps
): Promise<SubagentResult> {
  const angles = effort === "low" ? [null] : REVIEW_ANGLES_HIGH;
  
  const settled = await Promise.allSettled(
    angles.map((a) => {
      const task = a ? `${a.lens}\n\n${baseTask}` : baseTask;
      return deps.runSubagent(reviewer, task, deps.opts);
    })
  );

  const okResults = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value.result] : []));
  
  if (effort === "low" && okResults.length > 0) {
    return {
      ...okResults[0]!,
      task: baseTask,
      findings: dedupFindings(okResults[0]!.findings)
    };
  }

  const merged = dedupFindings(okResults.flatMap(r => r.findings));
  
  if (merged.length === 0) {
    return {
      profile: reviewer.name,
      task: baseTask,
      summary: "No findings across all angles.",
      findings: [],
      suggestedNextSteps: [],
      errors: []
    };
  }

  const verified = await deps.verifyFindings(merged, deps.opts);
  const kept = verified.filter((f) => f.verdict !== "refuted");
  const combinedSummary = okResults.map(r => r.summary).join("\n---\n");

  return {
    profile: reviewer.name,
    task: baseTask,
    summary: `Multi-angle review complete. Found ${kept.length} issues (dropped ${verified.length - kept.length} refuted).\n\nAngle Summaries:\n${combinedSummary}`,
    findings: kept,
    suggestedNextSteps: okResults.flatMap(r => r.suggestedNextSteps),
    errors: okResults.flatMap(r => r.errors)
  };
}
