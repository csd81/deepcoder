import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverDirectory, directoryWalk, type DiscoveredFile } from "./contextFiles.js";
import { expandImports, type ImportOptions } from "./importProcessor.js";
import { detectConflicts } from "./instructionConflicts.js";
import { renderStartup, renderJit, DEFAULT_STARTUP_MAX_BYTES } from "./instructionRenderer.js";

export type InstructionSourceKind =
  | "global"
  | "workspace"
  | "nested"
  | "local"
  | "rule"
  | "import"
  | "jit";

/** Public, serializable description of one instruction source. */
export interface InstructionSource {
  id: string;
  path: string;
  kind: InstructionSourceKind;
  directory: string;
  loadedAt: "startup" | "jit";
  reason: string;
  bytes: number;
  importedBy?: string;
  skipped?: boolean;
  skipReason?: string;
}

/** A loaded source plus its (import-expanded) text — internal to this module. */
export interface LoadedSource extends InstructionSource {
  text: string;
}

export type InstructionWarning =
  | { kind: "budget_exceeded"; sourcePath: string; message: string }
  | { kind: "import_cycle"; sourcePath: string; importPath: string; message: string }
  | { kind: "unsafe_import"; sourcePath: string; importPath: string; message: string }
  | { kind: "conflict"; sourcePaths: string[]; message: string };

export interface InstructionGraph {
  version: string;
  workspaceRoot: string;
  cwd: string;
  sources: LoadedSource[];
  renderedStartupText: string;
  /** Rendered text for JIT sources, keyed by source id (filled as they load). */
  renderedJitTextBySourceId: Record<string, string>;
  warnings: InstructionWarning[];
}

export interface BuildOptions {
  workspaceRoot: string;
  cwd?: string;
  /** Directory holding the global instruction file (default ~/.deepcoder). */
  globalDir?: string;
  version?: string;
  startupMaxBytes?: number;
  importsEnabled?: boolean;
  importMaxDepth?: number;
  importMaxBytes?: number;
}

/**
 * Build the startup instruction graph: a global file, then a workspace-root→cwd
 * walk, each directory contributing its supported instruction files in apply
 * order. Imports are expanded safely, conflicts are surfaced as warnings, and
 * the whole thing is rendered into one bounded, attributed block.
 *
 * Pure with respect to the model: reads files only, never throws.
 */
export function buildInstructionGraph(opts: BuildOptions): InstructionGraph {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const cwd = path.resolve(opts.cwd ?? workspaceRoot);
  const globalDir = opts.globalDir ?? path.join(os.homedir(), ".deepcoder");
  const importOpts = resolveImportOptions(opts, workspaceRoot, globalDir);
  const warnings: InstructionWarning[] = [];
  const sources: LoadedSource[] = [];

  // 1. Global instruction file(s).
  for (const d of discoverDirectory(globalDir, "global")) {
    loadFile(d, "startup", sources, warnings, importOpts);
  }
  // 2. Workspace root → cwd walk. The root directory is "workspace"; deeper
  //    directories on the walk are "nested" but still startup-loaded.
  const walk = directoryWalk(workspaceRoot, cwd);
  walk.forEach((dir, i) => {
    const override = i === 0 ? undefined : "nested";
    for (const d of discoverDirectory(dir, override)) {
      loadFile(d, "startup", sources, warnings, importOpts);
    }
  });

  // 3. Conflicts across everything that actually loaded.
  warnings.push(
    ...detectConflicts(
      sources.filter((s) => !s.skipped).map((s) => ({ path: relOrAbs(workspaceRoot, s.path), text: s.text })),
    ),
  );

  const graph: InstructionGraph = {
    version: opts.version ?? "1",
    workspaceRoot,
    cwd,
    sources,
    renderedStartupText: "",
    renderedJitTextBySourceId: {},
    warnings,
  };
  graph.renderedStartupText = renderStartup(
    sources,
    workspaceRoot,
    opts.startupMaxBytes ?? DEFAULT_STARTUP_MAX_BYTES,
    warnings,
  );
  return graph;
}

/**
 * Given an absolute path a tool just accessed, return any path-local
 * instruction sources (under directories between the workspace root and that
 * path) that are NOT already in the graph. The caller is responsible for
 * appending them to `graph.sources` / rendering once it decides to inject.
 *
 * This is the JIT mechanism: nested `AGENTS.md`/`CLAUDE.md` load only when a
 * file under their directory becomes relevant.
 */
export function pathLocalSources(graph: InstructionGraph, accessedAbsPath: string): LoadedSource[] {
  const target = path.resolve(accessedAbsPath);
  const rel = path.relative(graph.workspaceRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return []; // outside the workspace
  const fileDir = path.dirname(target);
  const dirs = directoryWalk(graph.workspaceRoot, fileDir);
  const known = new Set(graph.sources.map((s) => s.path));
  const importOpts = resolveImportOptions({}, graph.workspaceRoot, "");
  const out: LoadedSource[] = [];
  for (const dir of dirs) {
    if (path.resolve(dir) === graph.workspaceRoot) continue; // root handled at startup
    for (const d of discoverDirectory(dir, "nested")) {
      if (known.has(d.absPath)) continue;
      const loaded = loadFile({ ...d, kind: "jit", reason: `path-local (accessed ${path.basename(target)})` }, "jit", out, graph.warnings, importOpts);
      if (loaded) known.add(d.absPath);
    }
  }
  return out;
}

/** Render a JIT source and record it on the graph (call once per injection). */
export function commitJitSource(graph: InstructionGraph, src: LoadedSource): string {
  graph.sources.push(src);
  const rendered = renderJit(src, graph.workspaceRoot);
  graph.renderedJitTextBySourceId[src.id] = rendered;
  return rendered;
}

function loadFile(
  d: DiscoveredFile,
  loadedAt: "startup" | "jit",
  into: LoadedSource[],
  warnings: InstructionWarning[],
  importOpts: ImportOptions,
): LoadedSource | null {
  let raw: string;
  try {
    raw = readFileSync(d.absPath, "utf8");
  } catch {
    return null; // not present — silent (these are optional files)
  }
  if (!raw.trim()) return null; // empty file — nothing to contribute
  const expanded = expandImports(raw, d.absPath, importOpts);
  warnings.push(...expanded.warnings);
  const src: LoadedSource = {
    id: makeId(d.absPath, loadedAt),
    path: d.absPath,
    kind: d.kind,
    directory: d.directory,
    loadedAt,
    reason: d.reason,
    bytes: Buffer.byteLength(raw),
    text: expanded.text,
  };
  into.push(src);
  // Record imported files as their own attributed sources (kind "import").
  for (const imp of expanded.imported) {
    into.push({
      id: makeId(imp.absPath, loadedAt),
      path: imp.absPath,
      kind: "import",
      directory: path.dirname(imp.absPath),
      loadedAt,
      reason: `imported by ${path.basename(imp.importedBy)}`,
      bytes: imp.bytes,
      importedBy: imp.importedBy,
      text: "", // the content is already inlined into the importer's text
    });
  }
  return src;
}

function resolveImportOptions(
  opts: Pick<BuildOptions, "importsEnabled" | "importMaxDepth" | "importMaxBytes">,
  workspaceRoot: string,
  globalDir: string,
): ImportOptions {
  const roots = [workspaceRoot];
  if (globalDir) roots.push(path.resolve(globalDir));
  return {
    allowedRoots: roots,
    enabled: opts.importsEnabled ?? true,
    maxDepth: opts.importMaxDepth ?? 4,
    maxBytes: opts.importMaxBytes ?? 65_536,
  };
}

function relOrAbs(root: string, p: string): string {
  const r = path.relative(root, p);
  return r === "" || r.startsWith("..") ? p : r;
}

let idCounter = 0;
function makeId(absPath: string, loadedAt: string): string {
  return `${loadedAt}:${path.basename(absPath)}:${idCounter++}`;
}
