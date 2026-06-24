/**
 * Auto-refactor — structure discovery.
 *
 * `discoverStructure` turns the regex-based repo index into a `RepoStructure`:
 * the code under `src/` grouped by top-level area (`src/<area>`), each area
 * carrying its files, its covering tests (the behavior-preserving anchor), its
 * reverse-import fan-in (a blast-radius / risk signal), and duplicate-symbol
 * groups (a `dedupe` candidate signal). It is the deterministic front-end the
 * refactor planner consumes — no model, no mutation.
 *
 * Note on the index source: `ensureIndex` (src/index/store.ts) builds with
 * `{imports}` only, so its persisted index has NO symbols. Discovery needs
 * symbols for dedupe/extract-helper signals, so it defaults to a fresh
 * `buildRepoIndex(root,{symbols:true,imports:true})`. The builder is injectable
 * so tests pass a literal `RepoIndex` (no scan, no model).
 */
import { buildRepoIndex } from "../index/scanner.js";
import { relevantTests } from "../index/testTargeting.js";
import { impactedBy } from "../index/impact.js";
import type { RepoIndex } from "../index/types.js";

/** A duplicate symbol name observed across ≥2 files within one area. */
export interface DuplicateSymbol {
  name: string;
  /** Workspace-relative files (sorted) that each define a symbol of this name. */
  files: string[];
}

export interface AreaStructure {
  /** Top-level area path, e.g. "src/auth". */
  area: string;
  /** Code files under the area (workspace-relative, sorted). */
  files: string[];
  /** Covering tests for the area's files (union of relevantTests, sorted). */
  testFiles: string[];
  /** Largest single-file count of files that import (transitively) into a file
   *  of this area — a blast-radius signal for "split-module"/risk. */
  fanIn: number;
  /** Files in the area carrying many symbols (extract-helper signal). */
  largeFiles: { file: string; symbolCount: number }[];
  /** Symbol names defined in ≥2 of the area's files (dedupe signal). */
  duplicateSymbols: DuplicateSymbol[];
}

export interface RepoStructure {
  root: string;
  areas: AreaStructure[];
  /** True when the index has no code under `src/` (empty/uninitialised repo). */
  indexEmpty: boolean;
}

export interface DiscoveryDeps {
  /** Build (or supply) the repo index. Default: a fresh symbol+import scan. */
  buildIndex?: (root: string) => Promise<RepoIndex | null>;
}

/** A file is "large" (extract-helper candidate) at or above this symbol count. */
export const LARGE_FILE_SYMBOLS = 12;

/**
 * Discover the refactorable structure of a repo: `src/` code grouped by area.
 * Never throws — a missing/empty index yields `{ areas: [], indexEmpty: true }`.
 */
export async function discoverStructure(
  root: string,
  deps: DiscoveryDeps = {},
): Promise<RepoStructure> {
  const buildIndex =
    deps.buildIndex ?? ((r: string) => buildRepoIndex(r, { symbols: true, imports: true }));

  let index: RepoIndex | null;
  try {
    index = await buildIndex(root);
  } catch {
    index = null;
  }

  if (!index || index.files.length === 0) {
    return { root, areas: [], indexEmpty: true };
  }

  // Group code files by top-level area: src/<area>.
  const byArea = new Map<string, string[]>();
  for (const f of index.files) {
    if (f.kind !== "code") continue;
    const area = topLevelArea(f.path);
    if (!area) continue;
    let list = byArea.get(area);
    if (!list) byArea.set(area, (list = []));
    list.push(f.path);
  }

  if (byArea.size === 0) {
    return { root, areas: [], indexEmpty: true };
  }

  // Pre-group symbols by file for cheap per-area lookups.
  const symbolsByFile = new Map<string, Set<string>>();
  for (const s of index.symbols) {
    let set = symbolsByFile.get(s.file);
    if (!set) symbolsByFile.set(s.file, (set = new Set()));
    set.add(s.name);
  }

  const areas: AreaStructure[] = [];
  for (const [area, filesUnsorted] of byArea) {
    const files = [...filesUnsorted].sort();

    // Covering tests (union) + fan-in (max) across the area's files.
    const testSet = new Set<string>();
    let fanIn = 0;
    for (const file of files) {
      for (const t of relevantTests(index, file)) testSet.add(t);
      const reach = impactedBy(index, file).length;
      if (reach > fanIn) fanIn = reach;
    }

    // Large files (extract-helper) and duplicate symbol names (dedupe).
    const largeFiles: { file: string; symbolCount: number }[] = [];
    const nameToFiles = new Map<string, Set<string>>();
    for (const file of files) {
      const names = symbolsByFile.get(file);
      if (!names) continue;
      if (names.size >= LARGE_FILE_SYMBOLS) {
        largeFiles.push({ file, symbolCount: names.size });
      }
      for (const name of names) {
        let set = nameToFiles.get(name);
        if (!set) nameToFiles.set(name, (set = new Set()));
        set.add(file);
      }
    }
    const duplicateSymbols: DuplicateSymbol[] = [];
    for (const [name, fileSet] of nameToFiles) {
      if (fileSet.size >= 2) duplicateSymbols.push({ name, files: [...fileSet].sort() });
    }
    duplicateSymbols.sort((a, b) => a.name.localeCompare(b.name));
    largeFiles.sort((a, b) => a.file.localeCompare(b.file));

    areas.push({
      area,
      files,
      testFiles: [...testSet].sort(),
      fanIn,
      largeFiles,
      duplicateSymbols,
    });
  }

  areas.sort((a, b) => a.area.localeCompare(b.area));
  return { root, areas, indexEmpty: false };
}

/** "src/auth/login.ts" → "src/auth"; returns null for anything not under src/. */
function topLevelArea(relPath: string): string | null {
  const p = relPath.replace(/\\/g, "/");
  const parts = p.split("/");
  if (parts.length < 2 || parts[0] !== "src") return null;
  return `src/${parts[1]}`;
}
