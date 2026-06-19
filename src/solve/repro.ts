// Phase 5C — solver-side repro-test generation: pure helpers.
//
// The solver can generate its own failing test ("repro") when there is no
// user-configured check to solve against. These helpers are intentionally pure
// and side-effect free so they unit-test without a model or a subprocess; the
// solver does the actual running (via the shared, sandboxed `runCheck`) and the
// file I/O, then asks these functions to classify the outcome.

/** The subset of a check run these classifiers reason about. */
export interface ReproRunResult {
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * A generated repro is only trustworthy if it FAILS on the pre-fix (buggy) tree
 * — that proves it actually captures the bug. A pass, a timeout, or a spawn
 * failure all mean we could not establish "red", so the repro is invalid and
 * must be discarded (never used to grade a fix).
 */
export function validateReproIsRed(run: ReproRunResult): { red: boolean; reason?: string } {
  if (run.timedOut) return { red: false, reason: "the repro test timed out (could not establish a red baseline)" };
  if (run.exitCode === null) return { red: false, reason: "the repro test did not run (spawn/setup failure)" };
  if (run.exitCode === 0) return { red: false, reason: "the repro test passed on the buggy tree (it does not capture the bug)" };
  return { red: true };
}

/** A repro "passes" only on a clean exit 0 (a timeout is never a pass). */
export function reproPassed(run: ReproRunResult): boolean {
  return !run.timedOut && run.exitCode === 0;
}

/**
 * Cheap structural guard against a shallow/self-satisfying test. Model-authored
 * content is untrusted: a test with no assertion, or one that asserts a constant
 * truth, can go green without proving anything. This is a heuristic flag, not a
 * proof — a flagged repro is reported, never silently trusted as an oracle.
 */
export function isTautologicalRepro(content: string): { tautological: boolean; reason?: string } {
  const text = content.trim();
  if (!text) return { tautological: true, reason: "the repro file is empty" };

  // Constant-truth assertions prove nothing regardless of the product code.
  const constantTruth = [
    /\bassert\s*\(\s*true\s*\)/i,
    /\bassert\s+True\b/, // python: assert True
    /\bassertTrue\s*\(\s*True\s*\)/,
    /\bexpect\s*\(\s*true\s*\)\s*\.\s*to(?:Be|BeTruthy|Equal)?\s*\(\s*true\s*\)/i,
    /\bassert\s*\(\s*1\s*(?:===?\s*1)?\s*\)/,
  ];
  for (const re of constantTruth) {
    if (re.test(text)) return { tautological: true, reason: "the repro asserts a constant truth" };
  }

  // No assertion at all means there is no oracle — a green run is meaningless.
  const hasAssertion = /\b(assert|expect|should|throws?|toEqual|toBe|equal|strictEqual|deepEqual)\b/i.test(text);
  if (!hasAssertion) return { tautological: true, reason: "the repro contains no assertion" };

  return { tautological: false };
}

/**
 * Derive a command to run a single repro test file, from its extension alone.
 * Returns null when we don't know how to run it (the caller then falls back to a
 * configured check, or refuses). The command always targets just this one file
 * so it is fast and isolated; it still runs through the gated/sandboxed runner.
 */
export function deriveReproCommand(reproPath: string): string | null {
  const p = reproPath.replace(/\\/g, "/");
  const q = JSON.stringify(p); // shell-safe double-quoting for a workspace-relative path
  if (/\.(mjs|cjs|js)$/.test(p)) return `node --test ${q}`;
  if (/\.ts$/.test(p)) return `node --import tsx --test ${q}`;
  if (/\.py$/.test(p)) return `python -m pytest ${q} -q`;
  return null;
}

/**
 * A repro path must be workspace-relative and stay inside the tree (no absolute
 * path, no `..` escape). Returns the normalized path or null if it escapes.
 */
export function safeReproPath(reproPath: string): string | null {
  const p = reproPath.replace(/\\/g, "/").trim();
  if (!p) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null; // absolute
  if (p.split("/").some((seg) => seg === "..")) return null; // escapes the root
  return p;
}

/** Scratch repros live under `.deepcoder/`; they are discarded, not kept. */
export function isScratchReproPath(reproPath: string): boolean {
  return reproPath.replace(/\\/g, "/").startsWith(".deepcoder/");
}
