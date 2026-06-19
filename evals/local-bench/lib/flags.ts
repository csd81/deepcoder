// Deterministic patch-quality flags for the local bugfix benchmark.
//
// A patch can pass the visible test and STILL be a bad fix (the flask lesson:
// `assert` instead of `raise ValueError`, or an empty patch that "passes" a
// green baseline). These flags turn that into a hard signal: a case is only
// `solved` when the test passes AND there are zero quality flags.
//
// Pure functions — no model, no fs — so they are fully unit-testable.

export interface QualityInput {
  /** Unified `git diff` of the agent's change. */
  patch: string;
  /** Per-attempt patch metadata from the solve telemetry (for repeat detection). */
  attempts: { patchHash?: string | null; patchBytes?: number | null }[];
  /** Case-declared regex (strings) the fix must NOT contain (matched on added lines). */
  forbiddenPatterns: string[];
  /** Case-declared regex (strings) the fix MUST contain (matched on added lines). */
  requiredPatterns: string[];
  /** Paths the fix is expected to touch; anything else is flagged unrelated. Empty = no constraint. */
  allowedPaths: string[];
  /** Patch byte size above which the change is "huge" (default 20 KB). */
  hugePatchBytes?: number;
  /** Paths the fix MUST touch — a missing one flags `missing_expected_change`. Empty = no constraint. */
  expectedChangedPaths?: string[];
  /** Paths that must NOT change — touching one flags `forbidden_path_changed`. Empty = no constraint. */
  forbiddenChangedPaths?: string[];
  /** Regression-test paths the agent must add/update — none changed flags `missing_required_test`. Empty = no constraint. */
  requiredTestPaths?: string[];
  /** True when the agent's own regression test did NOT go red on the buggy baseline (runner-computed). */
  reproInvalid?: boolean;
  /** Minimum changed paths; fewer flags `too_few_changed_paths`. 0/undefined = no constraint. */
  minChangedPaths?: number;
  /** Maximum changed paths; more flags `too_many_changed_paths`. 0/undefined = no constraint. */
  maxChangedPaths?: number;
  /** Each group must contribute ≥1 changed path, else `missing_required_path_group`. Empty = no constraint. */
  requiredChangedPathGroups?: string[][];
}

const TEST_PATH_RE = /(^|\/)(tests?\/|test_|conftest\.py$)|(\.test\.|_test\.|\.spec\.)/i;
const DEFAULT_HUGE_BYTES = 20_000;

/** True iff `p` equals `a` or sits under it (directory prefix). */
function underPath(p: string, a: string): boolean {
  return p === a || p.startsWith(a.replace(/\/+$/, "") + "/");
}

/** Files added/modified in a unified diff, from its `+++ b/<path>` headers. */
export function changedPathsFromPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") out.push(m[1]);
  }
  return out;
}

/** Only the added content of a diff (lines starting with a single `+`), so we
 *  match the new code — not context or removed lines or the `+++` header. */
export function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** Returns the sorted list of quality-flag names for this patch (empty = clean). */
export function computeQualityFlags(input: QualityInput): string[] {
  const flags = new Set<string>();
  const patch = input.patch ?? "";
  const added = addedLines(patch);
  const changed = changedPathsFromPatch(patch);
  const hugeBytes = input.hugePatchBytes ?? DEFAULT_HUGE_BYTES;

  if (patch.trim() === "" || changed.length === 0) {
    flags.add("no_code_change");
  } else {
    if (Buffer.byteLength(added, "utf8") > hugeBytes) flags.add("huge_patch");

    if (input.allowedPaths.length > 0) {
      if (changed.some((p) => !input.allowedPaths.some((a) => underPath(p, a)))) {
        flags.add("unrelated_files");
      }
    }

    if (changed.every((p) => TEST_PATH_RE.test(p))) flags.add("test_only");

    // A required path the fix was expected to touch but didn't.
    const expected = input.expectedChangedPaths ?? [];
    if (expected.length > 0 && expected.some((e) => !changed.some((p) => underPath(p, e)))) {
      flags.add("missing_expected_change");
    }

    // A path the fix must not touch (caller-only / public-test hack).
    const forbidden = input.forbiddenChangedPaths ?? [];
    if (forbidden.length > 0 && changed.some((p) => forbidden.some((f) => underPath(p, f)))) {
      flags.add("forbidden_path_changed");
    }

    // A regression test the agent was required to add/update but didn't.
    const requiredTests = input.requiredTestPaths ?? [];
    if (requiredTests.length > 0 && !requiredTests.some((t) => changed.some((p) => underPath(p, t)))) {
      flags.add("missing_required_test");
    }

    // Repo-scale coordination: count + grouping constraints (Phase 6E).
    const min = input.minChangedPaths ?? 0;
    if (min > 0 && changed.length < min) flags.add("too_few_changed_paths");
    const max = input.maxChangedPaths ?? 0;
    if (max > 0 && changed.length > max) flags.add("too_many_changed_paths");

    // Each declared group must contribute at least one changed path.
    const groups = input.requiredChangedPathGroups ?? [];
    if (groups.some((g) => !g.some((a) => changed.some((p) => underPath(p, a))))) {
      flags.add("missing_required_path_group");
    }

    for (const pat of input.forbiddenPatterns) {
      if (safeMatch(pat, added)) flags.add("forbidden_pattern");
    }
    for (const pat of input.requiredPatterns) {
      if (!safeMatch(pat, added)) flags.add("missing_required_pattern");
    }
  }

  // The agent's own regression test did not capture the bug (didn't go red on
  // the buggy baseline). Runner-computed; grading falls back to the oracle.
  if (input.reproInvalid) flags.add("repro_invalid");

  // A non-empty patch hash repeated across attempts == the agent re-proposed the
  // same edit (stuck), even if a later attempt "passed".
  const hashes = input.attempts
    .filter((a) => (a.patchBytes ?? 0) > 0 && a.patchHash)
    .map((a) => a.patchHash as string);
  if (hashes.length !== new Set(hashes).size) flags.add("repeated_patch");

  return [...flags].sort();
}

/** Verdict the report keys on: a green test with a bad patch is NOT solved. */
export function verdict(testsPassed: boolean, qualityFlags: string[]): {
  tests_passed: boolean;
  quality_passed: boolean;
  solved: boolean;
} {
  const quality_passed = qualityFlags.length === 0;
  return { tests_passed: testsPassed, quality_passed, solved: testsPassed && quality_passed };
}

/** A malformed case regex must never crash the runner — treat it as "no match". */
function safeMatch(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "m").test(text);
  } catch {
    return false;
  }
}
