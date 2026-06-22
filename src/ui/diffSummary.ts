/**
 * Phase 10A — unified-diff parser (pure, no I/O).
 *
 * Splits a unified-diff by file, counts added/removed lines per file, and
 * returns structured summaries.  Never throws on malformed input; every consumer
 * must also redact secrets before display.
 */

import { redactSecrets } from "../workspace/redact.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiffFileSummary {
  /** Workspace-relative file path extracted from ---/+++ headers. */
  path: string;
  /** Number of added lines (lines starting with `+` but not `+++`). */
  additions: number;
  /** Number of deleted lines (lines starting with `-` but not `---`). */
  deletions: number;
  /** Number of hunk headers (@@ …). */
  hunks: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a complete unified-diff string and return one summary per affected file.
 *
 * Supports `diff --git a/… b/…`, `--- a/…` / `+++ b/…`, and `@@ … @@` hunk
 * headers.  Malformed diffs are handled gracefully — unrecognised sections are
 * silently skipped and never throw.
 */
export function summarizeUnifiedDiff(diff: string): DiffFileSummary[] {
  const files = splitUnifiedDiffByFile(diff);
  return files.map((f) => {
    let additions = 0;
    let deletions = 0;
    let hunks = 0;

    for (const line of f.lines) {
      if (line.startsWith("@@") && line.includes("@@")) {
        hunks++;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }

    return { path: f.path, additions, deletions, hunks };
  });
}

/**
 * Split a unified-diff string into per-file chunks.
 *
 * Returns an array of `{ path, lines }` objects.  The path is extracted from the
 * `+++ b/…` header (falling back to `--- a/…` or `diff --git a/… b/…`).  Lines
 * include the full content for each segment including the file header lines.
 * Malformed input yields a single unnamed chunk containing the text as-is.
 */
export function splitUnifiedDiffByFile(
  diff: string,
): { path: string; lines: string[] }[] {
  if (!diff || diff.trim() === "") return [];

  const allLines = diff.split("\n");
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;

  /**
   * Try to extract a file path from a line.  Checks, in order:
   *   - `diff --git a/… b/…` → b/… side
   *   - `+++ b/…`            → b/… side
   *   - `--- a/…`            → a/… side
   */
  function extractPath(line: string): string | undefined {
    // diff --git a/src/foo.ts b/src/foo.ts
    const gitMatch = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (gitMatch) return gitMatch[2]; // prefer b/ side

    // +++ b/src/foo.ts
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch) return plusMatch[1];

    // --- a/src/foo.ts
    const minusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMatch) return minusMatch[1];

    return undefined;
  }

  for (const line of allLines) {
    const maybePath = extractPath(line);

    // Start a new file segment when we see a `diff --git` header or a
    // `---`/`+++` pair that indicates a new file (only if we already have
    // a current file, to avoid empty leading segments).
    if (maybePath !== undefined) {
      if (line.startsWith("diff --git")) {
        // Definitely a new file; close the previous segment if open.
        current = { path: maybePath, lines: [line] };
        files.push(current);
        continue;
      }

      // --- or +++ line: if we have a current file, add to it; otherwise
      // start a new segment.
      if (current === null) {
        current = { path: maybePath, lines: [line] };
        files.push(current);
      } else {
        current.lines.push(line);
      }
      continue;
    }

    // If we're not inside a file segment, start an anonymous one.
    if (current === null) {
      current = { path: "", lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }

  return files;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

/**
 * Render a compact diff-stat string like `+12 -3` for a single summary,
 * or aggregate across multiple summaries.
 */
export function formatDiffStat(summaries: DiffFileSummary[]): string {
  const totalAdded = summaries.reduce((s, f) => s + f.additions, 0);
  const totalDel = summaries.reduce((s, f) => s + f.deletions, 0);
  return `+${totalAdded} -${totalDel}`;
}

/**
 * Cap lines to at most `max` lines; if truncated, append a notice as the last
 * line.  Always redacts secrets before returning.
 */
export function capLines(
  lines: string[],
  max: number,
  redact = true,
): string[] {
  const processed = redact ? lines.map(redactSecrets) : lines;
  if (processed.length <= max) return processed;
  return [
    ...processed.slice(0, Math.max(0, max - 1)),
    `… ${processed.length - max + 1} more lines (truncated)`,
  ];
}
