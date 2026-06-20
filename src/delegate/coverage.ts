/**
 * Phase 9M — Manifest coverage gate (pure helpers).
 *
 * A delegated worker authors a failing test for EACH deliverable in a manifest,
 * tagging every test title with `[<deliverable-id>]`. The harness runs the
 * authored suite on the clean baseline (TAP output) and proves, per deliverable:
 *   - it is covered  (≥1 tagged test exists), AND
 *   - it is red      (every tagged test fails on baseline — a tagged test that
 *                     passes on baseline is vacuous/self-grading and rejected).
 *
 * These functions are pure and deterministic so they can be unit-tested without
 * a worktree or a live model.
 */

export interface WorkerDeliverableSpec {
  /** Stable token used to tag tests: a test title must contain `[<id>]`. */
  id: string;
  /** Human acceptance description (the spec) — surfaced in prompts/review. */
  acceptance: string;
}

export interface TapTestResult {
  name: string;
  ok: boolean;
  /** TAP directive `# SKIP`/`# TODO` — neither a real pass nor a real fail. */
  skipped: boolean;
}

export interface CoverageEntry {
  deliverableId: string;
  /** Titles of tests tagged with this deliverable (excluding skipped). */
  tests: string[];
  /** True iff ≥1 non-skipped tagged test AND all of them failed on baseline. */
  red: boolean;
}

export interface CoverageReport {
  entries: CoverageEntry[];
  /** Deliverables with no non-skipped tagged test. */
  uncovered: string[];
  /** Deliverables whose tagged test PASSED on baseline (vacuous/self-grading). */
  nonRed: string[];
  /** Every deliverable is covered AND red. */
  complete: boolean;
}

/**
 * Parse node:test (TAP v13) output into per-test results. Recognises top-level
 * and nested `ok N - name` / `not ok N - name` lines and `# SKIP`/`# TODO`
 * directives. Tolerant of leading indentation (nested subtests).
 */
export function parseTapResults(tap: string): TapTestResult[] {
  const out: TapTestResult[] = [];
  if (!tap) return out;
  const lineRe = /^\s*(not ok|ok)\s+\d+\s*-?\s*(.*)$/;
  for (const raw of tap.split(/\r?\n/)) {
    const m = lineRe.exec(raw);
    if (!m) continue;
    const ok = m[1] === "ok";
    let name = m[2].trim();
    let skipped = false;
    // Split off a trailing TAP directive (`# SKIP ...`, `# TODO ...`).
    const dir = /#\s*(SKIP|TODO)\b/i.exec(name);
    if (dir) {
      skipped = true;
      name = name.slice(0, dir.index).trim();
    }
    if (name.length === 0) continue;
    out.push({ name, ok, skipped });
  }
  return out;
}

/** Match the tests tagged with a deliverable id (`[id]` substring), skipping skips. */
function taggedTests(id: string, results: TapTestResult[]): TapTestResult[] {
  const tag = `[${id}]`;
  return results.filter((r) => !r.skipped && r.name.includes(tag));
}

/**
 * Compute manifest coverage from baseline TAP results. A deliverable is
 * satisfied (at red time) iff it has ≥1 non-skipped tagged test and every such
 * test failed. Deterministic; order follows the manifest.
 */
export function computeCoverage(
  deliverables: WorkerDeliverableSpec[],
  results: TapTestResult[],
): CoverageReport {
  const entries: CoverageEntry[] = [];
  const uncovered: string[] = [];
  const nonRed: string[] = [];

  for (const d of deliverables) {
    const matched = taggedTests(d.id, results);
    const covered = matched.length > 0;
    const red = covered && matched.every((t) => !t.ok);
    entries.push({ deliverableId: d.id, tests: matched.map((t) => t.name), red });
    if (!covered) {
      uncovered.push(d.id);
    } else if (!red) {
      // Covered but at least one tagged test passed on baseline → vacuous.
      nonRed.push(d.id);
    }
  }

  const complete = uncovered.length === 0 && nonRed.length === 0;
  return { entries, uncovered, nonRed, complete };
}

/**
 * Green-side check: given GREEN-phase TAP results, every deliverable that was
 * required must now have all its tagged tests passing (and still be covered).
 * Returns the ids that are NOT green (missing or still failing).
 */
export function deliverablesNotGreen(
  deliverables: WorkerDeliverableSpec[],
  results: TapTestResult[],
): string[] {
  const notGreen: string[] = [];
  for (const d of deliverables) {
    const matched = taggedTests(d.id, results);
    if (matched.length === 0 || !matched.every((t) => t.ok)) {
      notGreen.push(d.id);
    }
  }
  return notGreen;
}
