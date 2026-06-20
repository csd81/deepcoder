import { parseChangedPaths } from "./patchValidator.js";

export interface PatchStat {
  path: string;
  added: number;
  removed: number;
  kind: "added" | "modified" | "deleted" | "renamed" | "unknown";
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
