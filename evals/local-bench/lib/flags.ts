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
}

const TEST_PATH_RE = /(^|\/)(tests?\/|test_|conftest\.py$)|(\.test\.|_test\.|\.spec\.)/i;
const DEFAULT_HUGE_BYTES = 20_000;

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
    if (Buffer.byteLength(patch, "utf8") > hugeBytes) flags.add("huge_patch");

    if (input.allowedPaths.length > 0) {
      const allowed = (p: string) =>
        input.allowedPaths.some(
          (a) => p === a || p.startsWith(a.replace(/\/+$/, "") + "/"),
        );
      if (changed.some((p) => !allowed(p))) flags.add("unrelated_files");
    }

    if (changed.every((p) => TEST_PATH_RE.test(p))) flags.add("test_only");

    for (const pat of input.forbiddenPatterns) {
      if (safeMatch(pat, added)) flags.add("forbidden_pattern");
    }
    for (const pat of input.requiredPatterns) {
      if (!safeMatch(pat, added)) flags.add("missing_required_pattern");
    }
  }

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
