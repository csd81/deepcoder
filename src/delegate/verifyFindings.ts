import type { SubagentFinding, FindingVerdict } from "../subagents/types.js";
import type { RunSubagentOptions } from "../subagents/types.js";
import { runSubagent } from "../subagents/runner.js";
import { verifier } from "../subagents/profiles.js";

// ── Pure helpers ────────────────────────────────────────────────────────────

export interface Verdict {
  index: number;
  verdict: FindingVerdict;
  evidence: string;
}

/**
 * Build the adjudication prompt for the verifier subagent.
 * Pure — no I/O.
 */
export function buildVerificationTask(findings: SubagentFinding[]): string {
  const items = findings
    .map((f, i) => {
      const loc = f.file ? `${f.file}${typeof f.line === "number" ? `:${f.line}` : ""}` : "unknown";
      return `${i + 1}. [${loc}] "${f.claim}"\n   Evidence: ${f.evidence.slice(0, 500)}`;
    })
    .join("\n\n");

  return [
    "Adjudicate each of the following claims against the actual codebase.",
    "Open each cited file:line independently and verify whether the claim holds.",
    "",
    items,
    "",
    'Reply with ONLY a JSON object: {"verdicts": [{"index": 1, "verdict": "confirmed|refuted|unverifiable", "evidence": "..."}]}',
    "- confirmed: the claim is accurate and the cited location supports it",
    "- refuted: the claim is false or the cited location contradicts it",
    "- unverifiable: you cannot determine either way from the available evidence",
    "Default to refuted or unverifiable when the cited file:line doesn't support the claim.",
    "Do NOT hunt for new issues — only evaluate the claims listed above.",
  ].join("\n");
}

/**
 * Parse the verifier's JSON response into structured verdicts.
 * Pure — never throws. On parse failure, all verdicts are "unverifiable".
 */
export function parseVerdicts(text: string, count: number): Verdict[] {
  try {
    // Extract JSON object from the response (may be wrapped in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback(count);
    const parsed = JSON.parse(jsonMatch[0]);
    const verdicts = parsed.verdicts;
    if (!Array.isArray(verdicts)) return fallback(count);

    const result = verdicts.map((v: unknown) => {
      const item = v as { index?: number; verdict?: string; evidence?: string };
      // buildVerificationTask numbers findings 1-based (`${i+1}`) and the
      // instruction example shows "index": 1, so the model emits 1-based
      // indices. Convert to the 0-based position applyVerdicts maps against.
      const idx = (typeof item.index === "number" ? item.index : 0) - 1;
      const vd = item.verdict as string;
      return {
        index: idx >= 0 && idx < count ? idx : -1,
        verdict: (["confirmed", "refuted", "unverifiable"] as FindingVerdict[]).includes(vd as FindingVerdict)
          ? (vd as FindingVerdict)
          : "unverifiable" as FindingVerdict,
        evidence: typeof item.evidence === "string" ? item.evidence.slice(0, 1000) : "",
      };
    });
    // Empty verdicts array → fallback
    if (result.length === 0) return fallback(count);
    return result;
  } catch {
    return fallback(count);
  }
}

function fallback(count: number): Verdict[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    verdict: "unverifiable" as FindingVerdict,
    evidence: "Verifier response could not be parsed.",
  }));
}

/**
 * Apply verdicts to findings. Orders confirmed-first.
 * Pure.
 */
export function applyVerdicts(findings: SubagentFinding[], verdicts: Verdict[]): SubagentFinding[] {
  const map = new Map<number, Verdict>();
  for (const v of verdicts) {
    if (v.index >= 0 && v.index < findings.length) map.set(v.index, v);
  }

  const annotated = findings.map((f, i) => {
    const v = map.get(i);
    if (v) {
      return { ...f, verdict: v.verdict, verifyEvidence: v.evidence };
    }
    return { ...f, verdict: "unverifiable" as FindingVerdict, verifyEvidence: "No verdict returned for this finding." };
  });

  // Sort: confirmed first, then refuted, then unverifiable
  const order: Record<FindingVerdict, number> = { confirmed: 0, refuted: 1, unverifiable: 2 };
  return annotated.sort((a, b) => (order[a.verdict ?? "unverifiable"] - order[b.verdict ?? "unverifiable"]));
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface VerifyDeps {
  workspaceRoot: string;
  provider: RunSubagentOptions["provider"];
  parentModel: string;
  subagentModel?: string;
  modelRouter?: RunSubagentOptions["modelRouter"];
  providerPool?: RunSubagentOptions["providerPool"];
  contextBudgetTokens: number;
  compactAt: number;
  signal: AbortSignal;
}

/**
 * Run adversarial verification on a set of findings.
 * Fail-safe: on any error, all findings are tagged "unverifiable".
 * Never throws. Never drops findings.
 * Returns findings byte-identical when empty (no verifier spawned).
 */
export async function verifyFindings(
  findings: SubagentFinding[],
  deps: VerifyDeps,
): Promise<SubagentFinding[]> {
  if (findings.length === 0) return findings;

  try {
    const task = buildVerificationTask(findings);
    const { finalText } = await runSubagent(verifier, task, {
      workspaceRoot: deps.workspaceRoot,
      provider: deps.provider,
      parentModel: deps.parentModel,
      subagentModel: deps.subagentModel,
      modelRouter: deps.modelRouter,
      providerPool: deps.providerPool,
      contextBudgetTokens: deps.contextBudgetTokens,
      compactAt: deps.compactAt,
      signal: deps.signal,
    });

    const verdicts = parseVerdicts(finalText ?? "", findings.length);
    return applyVerdicts(findings, verdicts);
  } catch {
    return findings.map((f) => ({ ...f, verdict: "unverifiable" as FindingVerdict, verifyEvidence: "Verifier subagent failed." }));
  }
}
