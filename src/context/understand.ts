import path from "node:path";

/**
 * Pure deterministic summary of a file listing.
 *
 * Phase 8F — no fs scan, no slash command, no cache wiring.
 */
export interface RepoUnderstanding {
  fileCount: number;
  /** Extension (lowercased, incl. dot) → count; "" for no extension. */
  byExtension: Record<string, number>;
  /** Unique first-path-segment of files that contain a "/", sorted. */
  topDirs: string[];
  /** Well-known root files present in the listing, sorted. */
  keyFiles: string[];
}

const WELL_KNOWN = [
  "package.json",
  "README.md",
  "tsconfig.json",
  ".gitignore",
  "AGENTS.md",
  "Dockerfile",
] as const;

/**
 * Build a structured summary from a list of (path, mtimeMs) tuples.
 * Deterministic: the same input (in any order) always produces the same output.
 */
export function summarizeRepo(
  files: { path: string; mtimeMs: number }[],
): RepoUnderstanding {
  const fileCount = files.length;

  // ── byExtension ──────────────────────────────────────────────
  const byExtension: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }

  // ── topDirs ──────────────────────────────────────────────────
  const dirSet = new Set<string>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash !== -1) {
      dirSet.add(f.path.slice(0, slash));
    }
  }
  const topDirs = [...dirSet].sort();

  // ── keyFiles ─────────────────────────────────────────────────
  const keyFiles: string[] = [];
  for (const wk of WELL_KNOWN) {
    const found = files.some((f) => {
      const base = path.basename(f.path);
      if (wk === "README.md") {
        return base.toLowerCase() === "readme.md";
      }
      return base === wk;
    });
    if (found) keyFiles.push(wk);
  }

  return { fileCount, byExtension, topDirs, keyFiles };
}
