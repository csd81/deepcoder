/**
 * Phase 9N — verify-then-force.
 *
 * The default delegation path lets a capable model do the whole task in ONE pass
 * (fast), then VERIFIES the finished patch instead of forcing a tests-first
 * two-phase loop. The same anti-self-grading guarantee is recovered without the
 * latency: split the patch into its test-file changes vs the rest, then
 *   - apply ONLY the test changes to the clean baseline → every deliverable's
 *     tagged test must FAIL (red) — proving the tests actually exercise the new
 *     code (a test that passes without the production change is vacuous), AND
 *   - apply the FULL patch → every deliverable's tagged test must PASS (green).
 * Plus a scope check (no out-of-allowlist files). Only if verification fails do
 * we escalate to the forcing loop (runWorkerTdd).
 *
 * The pure pieces (patch splitting, verdict) are unit-tested without a model.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createIsolatedWorkspace } from "../workspaceIsolation/index.js";
import type { WorkspaceIsolationConfig } from "../workspaceIsolation/types.js";
import { validatePatch } from "./patchValidator.js";
import { parseTapResults, computeCoverage, deliverablesNotGreen } from "./coverage.js";
import type { CoverageReport, WorkerDeliverableSpec } from "./coverage.js";
import { tddIsolationConfig, defaultCoverageProbe, type CoverageProbe } from "./tdd.js";

const DEFAULT_TEST_PREFIXES = ["test/", "tests/"];

/** True if a workspace-relative path is under one of the test prefixes. */
export function isTestPath(p: string, prefixes: string[] = DEFAULT_TEST_PREFIXES): boolean {
  const norm = p.replace(/\\/g, "/");
  return prefixes.some((pre) => norm === pre.replace(/\/$/, "") || norm.startsWith(pre));
}

/**
 * Split a unified git diff into per-file sections and keep only those whose
 * target path satisfies `keep`. Deterministic; pure. (Paths with spaces — git's
 * quoted form — are not specially handled; manifest test paths don't use them.)
 */
export function extractPatchForPaths(patchText: string, keep: (p: string) => boolean): string {
  const sections: { path: string; lines: string[] }[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of patchText.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2], lines: [line] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  const kept = sections.filter((s) => keep(s.path));
  if (kept.length === 0) return "";
  return kept.map((s) => s.lines.join("\n")).join("\n").replace(/\n*$/, "\n");
}

export interface VerifyVerdict {
  ok: boolean;
  scopeOk: boolean;
  /** tests-only-on-baseline: every deliverable covered AND red (non-vacuous). */
  redComplete: boolean;
  /** full-patch: every deliverable's tagged test passes. */
  greenComplete: boolean;
  coverage?: CoverageReport;
  notGreen: string[];
  reasons: string[];
}

/** Pure verdict from the two TAP runs + scope flag. */
export function evaluateVerify(
  deliverables: WorkerDeliverableSpec[],
  redTap: string,
  greenTap: string,
  greenExitZero: boolean,
  scopeOk: boolean,
): VerifyVerdict {
  const coverage = computeCoverage(deliverables, parseTapResults(redTap));
  const notGreen = deliverablesNotGreen(deliverables, parseTapResults(greenTap));
  const redComplete = coverage.complete;
  const greenComplete = greenExitZero && notGreen.length === 0;
  const reasons: string[] = [];
  if (!scopeOk) reasons.push("patch touches files outside the allowed paths");
  if (!redComplete) {
    if (coverage.uncovered.length > 0) reasons.push(`no tagged test for: ${coverage.uncovered.join(", ")}`);
    if (coverage.nonRed.length > 0) {
      reasons.push(`test passes WITHOUT the production change (vacuous) for: ${coverage.nonRed.join(", ")}`);
    }
  }
  if (!greenComplete && notGreen.length > 0) reasons.push(`not green after full patch: ${notGreen.join(", ")}`);
  return {
    ok: scopeOk && redComplete && greenComplete,
    scopeOk,
    redComplete,
    greenComplete,
    coverage,
    notGreen,
    reasons,
  };
}

export interface VerifyManifestInput {
  realRoot: string;
  fullPatch: string;
  deliverables: WorkerDeliverableSpec[];
  testCommand: string;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  testPathPrefixes?: string[];
  signal: AbortSignal;
  isolationConfig?: WorkspaceIsolationConfig;
  /** Injectable for tests; default routes through runCheck (see tdd.ts). */
  runCoverageProbe?: CoverageProbe;
  /** Optional: copy project checks into the worktree before probing. */
  provisionWorktree?: (worktreeRoot: string) => Promise<void>;
}

/** Apply a patch text into a worktree via `git apply` (best-effort). Returns ok. */
async function applyPatch(worktreeRoot: string, patchText: string): Promise<boolean> {
  if (patchText.trim().length === 0) return false;
  const tmp = path.join(worktreeRoot, "__verify.patch");
  await fs.writeFile(tmp, patchText, "utf8");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let ok = true;
  try {
    await execFileAsync("git", ["apply", "--whitespace=nowarn", tmp], { cwd: worktreeRoot });
  } catch {
    ok = false;
  }
  await fs.rm(tmp, { force: true });
  return ok;
}

/**
 * Verify a finished one-pass patch against a deliverable manifest: scope +
 * tests-red-on-baseline + full-green. Reuses the same coverage proofs as the
 * forcing loop, applied to the completed patch by splitting it.
 */
export async function verifyManifestCoverage(input: VerifyManifestInput): Promise<VerifyVerdict> {
  const prefixes = input.testPathPrefixes ?? DEFAULT_TEST_PREFIXES;
  const probe = input.runCoverageProbe ?? defaultCoverageProbe;

  // 1. Scope: no files outside the allowlist.
  const scope = validatePatch({
    patchText: input.fullPatch,
    allowedPaths: input.allowedPaths,
    forbiddenPaths: input.forbiddenPaths ?? [],
  });
  const scopeOk = scope.ok;

  // 2. Red proof — tests-only applied to baseline.
  const testsPatch = extractPatchForPaths(input.fullPatch, (p) => isTestPath(p, prefixes));
  let redTap = "";
  if (testsPatch.trim().length > 0) {
    const redIso = await createIsolatedWorkspace(input.realRoot, tddIsolationConfig(input.isolationConfig));
    try {
      await input.provisionWorktree?.(redIso.isolatedRoot);
      const applied = await applyPatch(redIso.isolatedRoot, testsPatch);
      if (applied) {
        const r = await probe({ workspaceRoot: redIso.isolatedRoot, testCommand: input.testCommand, signal: input.signal });
        redTap = r.refused ? "" : r.tap;
      }
    } finally {
      await redIso.cleanup().catch(() => {});
    }
  }

  // 3. Green proof — full patch applied.
  let greenTap = "";
  let greenExitZero = false;
  const greenIso = await createIsolatedWorkspace(input.realRoot, tddIsolationConfig(input.isolationConfig));
  try {
    await input.provisionWorktree?.(greenIso.isolatedRoot);
    const applied = await applyPatch(greenIso.isolatedRoot, input.fullPatch);
    if (applied) {
      const g = await probe({ workspaceRoot: greenIso.isolatedRoot, testCommand: input.testCommand, signal: input.signal });
      greenTap = g.refused ? "" : g.tap;
      greenExitZero = !g.refused && g.exitCode === 0;
    }
  } finally {
    await greenIso.cleanup().catch(() => {});
  }

  return evaluateVerify(input.deliverables, redTap, greenTap, greenExitZero, scopeOk);
}
