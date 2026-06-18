import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolResult } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveReadPathInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath, SENSITIVE_GLOB_EXCLUDES } from "../workspace/sensitive.js";

const execFileAsync = promisify(execFile);

const schema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().default(".").describe("Directory or file to search, relative to workspace root."),
  glob: z.string().optional().describe("Optional glob to filter files, e.g. '*.ts'."),
});

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".deepcoder", "coverage", ".next", "build", ".cache"]);
const MAX_MATCH_LINES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const grepTool: Tool = {
  name: "grep",
  kind: "read-only",
  description:
    "Search file contents for a regex. Uses ripgrep (rg) when available, otherwise a built-in scan. " +
    "Returns matching lines with file:line prefixes.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("grep", schema, raw);
    return {
      kind: "read-only",
      describe: () => `grep "${args.pattern}" in ${args.path}`,
      async execute(ctx) {
        if (isSensitivePath(args.path)) {
          return {
            output: `Searching ${args.path} is blocked: it may contain secrets. It was not searched.`,
            isError: true,
          };
        }
        // Symlink-safe: an explicit symlink target can't point the search outside
        // the workspace (recursive scans already skip symlinks during traversal).
        let abs: string;
        try {
          abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.path);
        } catch (err) {
          return { output: (err as Error).message, isError: true };
        }
        if (isSensitivePath(displayPath(ctx.workspaceRoot, abs))) {
          return { output: `Searching ${args.path} is blocked: it resolves to a sensitive path.`, isError: true };
        }
        const rgArgs = ["--line-number", "--no-heading", "--color=never"];
        // Always exclude secret files so a broad search (e.g. path ".") can't
        // pull .env / .deepcoder contents into the model context.
        for (const ex of SENSITIVE_GLOB_EXCLUDES) rgArgs.push("--glob", ex);
        if (args.glob) rgArgs.push("--glob", args.glob);
        rgArgs.push(args.pattern, abs);
        try {
          const { stdout } = await execFileAsync("rg", rgArgs, {
            signal: ctx.signal,
            maxBuffer: 8 * 1024 * 1024,
          });
          const trimmed = stdout.trim();
          return { output: trimmed || "(no matches)" };
        } catch (err: unknown) {
          const e = err as { code?: number | string; stderr?: string };
          // rg exits 1 with no output when there are no matches.
          if (e.code === 1) return { output: "(no matches)" };
          // ripgrep not installed → fall back to a built-in scan (same guards).
          if (e.code === "ENOENT") {
            return grepFallback(ctx.workspaceRoot, abs, args.pattern, args.glob, ctx.signal);
          }
          return { output: `grep failed: ${e.stderr || String(err)}`, isError: true };
        }
      },
    };
  },
};

/**
 * Dependency-free grep used when ripgrep isn't on PATH. Walks the target with a
 * JS regex, applying the SAME safety guards as the rg path: sensitive files are
 * skipped, ignored/build dirs and binaries are excluded, and an optional glob
 * filters by path/basename.
 */
export async function grepFallback(
  workspaceRoot: string,
  target: string,
  pattern: string,
  glob: string | undefined,
  signal: AbortSignal,
): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { output: `invalid regex: ${(err as Error).message}`, isError: true };
  }
  const globRe = glob ? globToRegExp(glob) : null;

  const files: string[] = [];
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) await walk(target, files);
    else files.push(target);
  } catch (err) {
    return { output: `grep failed: ${(err as Error).message}`, isError: true };
  }

  const out: string[] = [];
  let truncated = false;
  let aborted = false;
  for (const abs of files) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    const rel = displayPath(workspaceRoot, abs);
    if (isSensitivePath(rel)) continue;
    if (globRe && !globRe.test(rel) && !globRe.test(path.basename(abs))) continue;
    let content: string;
    try {
      const buf = await fs.readFile(abs);
      if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        // Workspace-relative prefix (don't leak the absolute workspace path).
        out.push(`${rel}:${i + 1}:${lines[i]}`);
        if (out.length >= MAX_MATCH_LINES) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }

  if (aborted) return { output: out.length ? out.join("\n") + "\n… (search aborted)" : "(search aborted)", isError: true };
  if (out.length === 0) return { output: "(no matches)" };
  return { output: out.join("\n") + (truncated ? "\n… (results truncated)" : "") };
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
}

/** Treat a buffer as binary if it contains a NUL byte in the first 8 KB. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
