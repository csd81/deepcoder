import { readFileSync } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../workspace/sensitive.js";
import type { InstructionWarning } from "./instructionGraph.js";

export interface ImportOptions {
  /** Directories the import target must stay inside (absolute). */
  allowedRoots: string[];
  enabled: boolean;
  maxDepth: number;
  maxBytes: number;
}

/** One imported file, attributed back to the file that imported it. */
export interface ImportedFile {
  absPath: string;
  importedBy: string;
  bytes: number;
  text: string;
}

export interface ExpandResult {
  /** The containing file's text with each `@import` line replaced by a marker. */
  text: string;
  imported: ImportedFile[];
  warnings: InstructionWarning[];
}

// An import directive: a line whose sole content is `@<relative-path>.md`.
const IMPORT_LINE = /^@(\S+\.md)\s*$/;

/**
 * Expand `@./file.md` import directives in `text`, resolving relative to
 * `containingFile`. Bounded and safe:
 *  - absolute imports (`@/x` or `@C:\x`) are rejected,
 *  - targets escaping every allowed root are rejected,
 *  - sensitive targets (.env, .deepcoder, keys, …) are rejected,
 *  - depth is capped at `maxDepth`,
 *  - each imported file is capped at `maxBytes`,
 *  - cycles are detected, reported, and the repeated edge is skipped.
 *
 * Never throws; problems become {@link InstructionWarning}s and the offending
 * import is left as an inert comment.
 */
export function expandImports(
  text: string,
  containingFile: string,
  opts: ImportOptions,
): ExpandResult {
  const imported: ImportedFile[] = [];
  const warnings: InstructionWarning[] = [];
  if (!opts.enabled) return { text, imported, warnings };
  // `stack` carries the active import chain for cycle detection.
  const seen = new Set<string>([path.resolve(containingFile)]);
  const out = expand(text, containingFile, 0, seen, imported, warnings, opts);
  return { text: out, imported, warnings };
}

function expand(
  text: string,
  containingFile: string,
  depth: number,
  stack: Set<string>,
  imported: ImportedFile[],
  warnings: InstructionWarning[],
  opts: ImportOptions,
): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const m = IMPORT_LINE.exec(line.trim());
    if (!m) {
      result.push(line);
      continue;
    }
    const spec = m[1];
    if (path.isAbsolute(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) {
      warnings.push({
        kind: "unsafe_import",
        sourcePath: containingFile,
        importPath: spec,
        message: `absolute imports are disabled: @${spec}`,
      });
      result.push(`<!-- skipped absolute import: @${spec} -->`);
      continue;
    }
    const target = path.resolve(path.dirname(containingFile), spec);

    if (depth + 1 > opts.maxDepth) {
      warnings.push({
        kind: "budget_exceeded",
        sourcePath: containingFile,
        message: `import depth limit (${opts.maxDepth}) reached at @${spec}`,
      });
      result.push(`<!-- skipped (import depth limit): @${spec} -->`);
      continue;
    }
    if (!withinRoots(target, opts.allowedRoots)) {
      warnings.push({
        kind: "unsafe_import",
        sourcePath: containingFile,
        importPath: spec,
        message: `import escapes the workspace: @${spec}`,
      });
      result.push(`<!-- skipped (outside workspace): @${spec} -->`);
      continue;
    }
    if (isSensitivePath(target)) {
      warnings.push({
        kind: "unsafe_import",
        sourcePath: containingFile,
        importPath: spec,
        message: `refusing to import a sensitive path: @${spec}`,
      });
      result.push(`<!-- skipped (sensitive path): @${spec} -->`);
      continue;
    }
    if (stack.has(target)) {
      warnings.push({
        kind: "import_cycle",
        sourcePath: containingFile,
        importPath: spec,
        message: `import cycle detected at @${spec}; edge skipped`,
      });
      result.push(`<!-- skipped (import cycle): @${spec} -->`);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch {
      warnings.push({
        kind: "unsafe_import",
        sourcePath: containingFile,
        importPath: spec,
        message: `import not found or unreadable: @${spec}`,
      });
      result.push(`<!-- skipped (unreadable): @${spec} -->`);
      continue;
    }
    const bytes = Buffer.byteLength(raw);
    if (bytes > opts.maxBytes) {
      warnings.push({
        kind: "budget_exceeded",
        sourcePath: target,
        message: `imported file exceeds ${opts.maxBytes} bytes (${bytes}); truncated`,
      });
      raw = raw.slice(0, opts.maxBytes);
    }

    stack.add(target);
    const expandedChild = expand(raw, target, depth + 1, stack, imported, warnings, opts);
    stack.delete(target);

    imported.push({ absPath: target, importedBy: containingFile, bytes, text: expandedChild });
    result.push(`<!-- import: @${spec} -->`);
    result.push(expandedChild);
  }
  return result.join("\n");
}

function withinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}
