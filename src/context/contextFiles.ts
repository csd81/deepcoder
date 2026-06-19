import { readdirSync } from "node:fs";
import path from "node:path";
import type { InstructionSourceKind } from "./instructionGraph.js";

/**
 * One instruction file discovered in a directory, in the order it should be
 * applied (earlier entries first, later entries override on conflict).
 */
export interface DiscoveredFile {
  /** Absolute path to the file. */
  absPath: string;
  /** Directory (absolute) the file was discovered in. */
  directory: string;
  kind: InstructionSourceKind;
  /** Human-readable reason this file was loaded. */
  reason: string;
}

/**
 * Supported instruction filenames, in the precedence order they apply WITHIN a
 * single directory (earliest applied first). Cross-tool names are supported so
 * users migrating between Codex / Claude / Gemini can reuse existing context.
 *
 * Special cases handled by {@link discoverDirectory}:
 *  - `AGENTS.override.md` REPLACES `AGENTS.md` when present.
 *  - `.deepcoder/rules/*.md` is expanded (sorted) after `.deepcoder/instructions.md`.
 */
const SHARED_FILES: ReadonlyArray<{ name: string; kind: InstructionSourceKind }> = [
  { name: "AGENTS.md", kind: "workspace" },
  { name: "CLAUDE.md", kind: "workspace" },
  { name: "CLAUDE.local.md", kind: "local" },
  { name: "GEMINI.md", kind: "workspace" },
  { name: ".deepcoder/instructions.md", kind: "workspace" },
];

/**
 * Discover the supported instruction files in a single directory, in apply
 * order. `kindOverride` lets the caller tag everything as "global" or "nested"
 * depending on where the directory sits relative to the workspace root.
 *
 * Pure-ish: only reads the directory listing (for `AGENTS.override.md` and the
 * `.deepcoder/rules/*.md` glob). Never throws — an unreadable directory yields
 * an empty list.
 */
export function discoverDirectory(
  directory: string,
  kindOverride?: "global" | "nested",
): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const present = safeList(directory);

  // AGENTS.override.md replaces AGENTS.md (Codex-style local override).
  const agentsName = present.has("AGENTS.override.md") ? "AGENTS.override.md" : "AGENTS.md";

  for (const { name, kind } of SHARED_FILES) {
    const effectiveName = name === "AGENTS.md" ? agentsName : name;
    // For nested dirs, AGENTS.md/CLAUDE.md are subdirectory-scoped ("nested").
    const resolvedKind = kindOverride ?? kind;
    out.push({
      absPath: path.join(directory, effectiveName),
      directory,
      kind: resolvedKind,
      reason: reasonFor(effectiveName, kindOverride),
    });
  }

  // .deepcoder/rules/*.md — only that exact directory, only top-level *.md.
  // This can never reach .deepcoder/runs|sessions|checkpoints.
  const rulesDir = path.join(directory, ".deepcoder", "rules");
  for (const ruleName of safeList(rulesDir)) {
    if (!ruleName.endsWith(".md")) continue;
    out.push({
      absPath: path.join(rulesDir, ruleName),
      directory,
      kind: "rule",
      reason: `rule file (.deepcoder/rules/${ruleName})`,
    });
  }

  return out;
}

function reasonFor(name: string, kindOverride?: "global" | "nested"): string {
  if (kindOverride === "global") return `global instruction file (~/${name})`;
  if (kindOverride === "nested") return `nested instruction file (${name})`;
  return `workspace instruction file (${name})`;
}

/** Directory entries as a Set; empty (never throws) when the dir is missing. */
function safeList(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

/**
 * The directories to walk at startup, from workspace root down to `cwd`
 * (inclusive), root first so closer directories apply later. When `cwd` is the
 * root (the usual CLI case) this is just `[root]`. A `cwd` outside the root
 * collapses to `[root]` (we never walk above the workspace).
 */
export function directoryWalk(workspaceRoot: string, cwd: string): string[] {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(cwd);
  const rel = path.relative(root, target);
  if (rel === "") return [root];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [root];
  const dirs = [root];
  let acc = root;
  for (const seg of rel.split(path.sep)) {
    acc = path.join(acc, seg);
    dirs.push(acc);
  }
  return dirs;
}
