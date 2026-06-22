/**
 * Phase 10A — interactive @-file autocomplete (pure query + render; I/O in
 * buildFileIndex only).
 *
 * This module provides the data structures and pure functions for fuzzy-matching
 * workspace files and rendering a completion dropdown.  `buildFileIndex` is the
 * only I/O boundary (calls `git ls-files`); `queryFiles` and
 * `renderCompleterDropdown` are pure and fully testable without a git repo.
 */

// ── File Index ────────────────────────────────────────────────────────────────

export interface FileIndex {
  paths: string[];
  /** basename → paths lookup for fuzzy matching */
  byBasename: Map<string, string[]>;
}

/**
 * Build a file index from `git ls-files` output.
 * Cached for the session; refreshed on explicit request.
 */
export async function buildFileIndex(root: string): Promise<FileIndex> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("git", ["ls-files"], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  const paths = stdout.trim().split("\n").filter(Boolean);
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const base = p.split("/").pop()!;
    const existing = byBasename.get(base);
    if (existing) existing.push(p);
    else byBasename.set(base, [p]);
  }
  return { paths, byBasename };
}

// ── Pure query ────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match `query` against the file index.
 * Returns up to `maxResults` matches, scored by:
 *   1. basename prefix match (highest)
 *   2. basename substring match
 *   3. path substring match
 */
export function queryFiles(
  index: FileIndex,
  query: string,
  maxResults = 10,
): string[] {
  if (!query) return [];
  const lower = query.toLowerCase();

  // Directories: show files inside
  if (query.endsWith("/")) {
    return index.paths
      .filter((p) => p.startsWith(lower))
      .slice(0, maxResults);
  }

  // @-mentions: fuzzy match basename + path
  const scores = new Map<string, number>();
  for (const p of index.paths) {
    const base = p.split("/").pop()!.toLowerCase();
    let score = 0;
    if (base.startsWith(lower)) score = 1000 - base.length;
    else if (base.includes(lower)) score = 500 - base.length;
    else if (p.toLowerCase().includes(lower)) score = 100;
    else continue; // no match
    scores.set(p, score);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([p]) => p);
}

// ── Dropdown rendering ────────────────────────────────────────────────────────

export interface CompleterDropdown {
  lines: string[]; // rendered dropdown rows
  selected: number; // which line is highlighted
}

/**
 * Render the file completer dropdown.
 *
 * Pure: returns a bounded list of strings (each ≤ maxVisible lines).  The
 * selected line is marked with "▸" and others with "  ".  If there are more
 * matches than `maxVisible`, an ellipsis line is appended.
 */
export function renderCompleterDropdown(
  matches: string[],
  selected: number,
  maxVisible = 8,
): CompleterDropdown {
  const visible = matches.slice(0, maxVisible);
  const lines = visible.map((p, i) => {
    const marker = i === selected ? "▸ " : "  ";
    return `${marker}${p}`;
  });
  if (matches.length > maxVisible) {
    lines.push(`  … ${matches.length - maxVisible} more`);
  }
  return { lines, selected };
}
