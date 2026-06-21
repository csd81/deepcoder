import { parseChangedPaths } from "./patchValidator.js";

export interface PatchStat {
  path: string;
  added: number;
  removed: number;
  kind: "added" | "modified" | "deleted" | "renamed" | "unknown";
}

export interface DiffFileSection {
  path: string;
  kind: PatchStat["kind"];
  /** Every original diff line for this file's section, verbatim (lossless). */
  lines: string[];
}

/**
 * Split a unified patch into per-file sections for an interactive viewer.
 * Mirrors computePatchStat's boundary recognition so the file list and the diff
 * body agree file-for-file. A section opens on `diff --git a/<a> b/<b>` (path =
 * the b-side; renamed when a !== b); for headerless patches it opens on the
 * first `--- a/<p>` / `+++ b/<p>`. Every line is preserved inside its section.
 */
export function splitPatchByFile(patchText: string): DiffFileSection[] {
  if (!patchText.trim()) return [];
  const lines = patchText.split("\n");
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const aPath = m?.[1];
      const bPath = m?.[2] ?? aPath ?? "unknown";
      current = { path: bPath, kind: aPath && bPath && aPath !== bPath ? "renamed" : "modified", lines: [line] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Headerless patch (no `diff --git`): open a section on the first ---/+++.
      const am = line.match(/^--- a\/(.+)$/);
      const bm = line.match(/^\+\+\+ b\/(.+)$/);
      if (am || bm) {
        current = { path: (bm?.[1] ?? am?.[1])!, kind: "modified", lines: [line] };
        sections.push(current);
        continue;
      }
      // Pre-first-header preamble — skip (nothing to attribute it to).
      continue;
    }
    current.lines.push(line);
    if (line.startsWith("new file mode ") || line.startsWith("--- /dev/null")) current.kind = "added";
    else if (line.startsWith("deleted file mode ") || line.startsWith("+++ /dev/null")) current.kind = "deleted";
  }

  return sections;
}

export function computePatchStat(patchText: string): PatchStat[] {
  const stats: Record<string, PatchStat> = {};
  
  // We use parseChangedPaths to get the list of files, but we also need to parse the diff
  // to get added/removed lines and kind.
  
  const lines = patchText.split("\n");
  let currentPath: string | null = null;
  let currentStat: PatchStat | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        const aPath = match[1]!;
        const bPath = match[2]!;
        
        currentPath = bPath;
        if (!stats[currentPath]) {
          stats[currentPath] = {
            path: currentPath,
            added: 0,
            removed: 0,
            kind: aPath !== bPath ? "renamed" : "modified"
          };
        }
        currentStat = stats[currentPath]!;
      }
    } else if (line.startsWith("new file mode ")) {
      if (currentStat) currentStat.kind = "added";
    } else if (line.startsWith("deleted file mode ")) {
      if (currentStat) currentStat.kind = "deleted";
    } else if (line.startsWith("--- a/")) {
      if (!currentStat) {
        const match = line.match(/^--- a\/(.+)$/);
        if (match) {
          currentPath = match[1]!;
          if (!stats[currentPath]) {
            stats[currentPath] = {
              path: currentPath,
              added: 0,
              removed: 0,
              kind: "modified"
            };
          }
          currentStat = stats[currentPath]!;
        }
      }
    } else if (line.startsWith("+++ b/")) {
      if (!currentStat) {
        const match = line.match(/^\+\+\+ b\/(.+)$/);
        if (match) {
          currentPath = match[1]!;
          if (!stats[currentPath]) {
            stats[currentPath] = {
              path: currentPath,
              added: 0,
              removed: 0,
              kind: "modified"
            };
          }
          currentStat = stats[currentPath]!;
        }
      }
    } else if (line.startsWith("--- /dev/null")) {
      if (currentStat) currentStat.kind = "added";
    } else if (line.startsWith("+++ /dev/null")) {
      if (currentStat) currentStat.kind = "deleted";
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentStat) currentStat.added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (currentStat) currentStat.removed++;
    }
  }
  
  // Ensure all paths from parseChangedPaths are included, even if we missed them in our simple parsing
  const allPaths = parseChangedPaths(patchText);
  for (const p of allPaths) {
    if (!stats[p]) {
      stats[p] = {
        path: p,
        added: 0,
        removed: 0,
        kind: "unknown"
      };
    }
  }
  
  return Object.values(stats).sort((a, b) => a.path.localeCompare(b.path));
}
