import type { ImportEdge, RepoIndex } from "./types.js";

/**
 * Files transitively impacted by a change to `changedFile`: the set of files
 * that import it, directly or via a chain (reverse-import BFS). Bounded by
 * `maxDepth`. Returns workspace-relative paths, excluding the changed file.
 */
export function impactedBy(index: RepoIndex, changedFile: string, maxDepth = 8): string[] {
  const reverse = reverseGraph(index.imports);
  const seen = new Set<string>();
  let frontier = [changedFile];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of reverse.get(f) ?? []) {
        if (!seen.has(importer) && importer !== changedFile) {
          seen.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return [...seen].sort();
}

/** Map each file → the set of files that import it. */
export function reverseGraph(edges: ImportEdge[]): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    let s = rev.get(to);
    if (!s) rev.set(to, (s = new Set()));
    s.add(from);
  }
  return rev;
}
