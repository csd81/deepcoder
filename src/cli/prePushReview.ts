import type { SubagentFinding } from "../subagents/types.js";

export interface PrePushReviewResult {
  ok: boolean;
  issues: string[];
  exitCode: number;
}

/** Format a single finding as a human-readable one-line string. */
export function formatFinding(f: SubagentFinding): string {
  const loc = f.file ? (typeof f.line === "number" ? `${f.file}:${f.line}` : f.file) : null;
  const prefix = loc ? `[${f.severity}] ${loc}` : `[${f.severity}]`;
  return `${prefix}: ${f.claim} (${f.evidence})`;
}

/**
 * Run a pre-push review against a diff.
 *
 * The `reviewFn` is an INJECTED seam — in production this is wired to
 * `runMultiAngleReview` (src/delegate/multiAngleReview.ts), but tests inject
 * a fake so no LLM call is needed.
 *
 * Returns { ok: true, issues: [], exitCode: 0 } when the review finds
 * nothing. Returns { ok: false, issues, exitCode: 1 } when there are
 * findings (the git hook should abort the push).
 */
export async function prePushReview(
  diff: string,
  reviewFn: (diff: string) => Promise<SubagentFinding[]>,
): Promise<PrePushReviewResult> {
  const findings = await reviewFn(diff);

  if (findings.length === 0) {
    return { ok: true, issues: [], exitCode: 0 };
  }

  return {
    ok: false,
    issues: findings.map(formatFinding),
    exitCode: 1,
  };
}
