/**
 * Typed read-only git wrappers (Phase 0 of plans/new/feat-native-git-core-plan.md).
 *
 * Every wrapper builds its git arg array ONLY from typed options — never a raw
 * flag passthrough — and runs un-gated via `gitExec` (none are mutating). For
 * value-returning wrappers, a non-zero exit throws `new Error(stderr || …)`;
 * otherwise the parsed value is returned.
 */
import { gitExec } from "./core.js";

/** A single `git status --porcelain` entry: XY status codes + path. */
export interface StatusEntry {
  /** Staged (index) status code; " " when unmodified in the index. */
  x: string;
  /** Unstaged (work-tree) status code; " " when unmodified in the work tree. */
  y: string;
  /** Workspace-relative path (rename entries report the destination). */
  path: string;
}

/** Throw with git's stderr (or a fallback) on a non-zero exit. */
function fail(stderr: string, fallback: string): never {
  throw new Error(stderr.trim() || fallback);
}

/** Split output into trimmed, non-empty lines. */
function lines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * `git status --porcelain`, parsed into XY + path entries. Returns the raw
 * output alongside the structured entries.
 */
export async function status(
  root: string,
): Promise<{ raw: string; entries: StatusEntry[] }> {
  const res = await gitExec(root, ["status", "--porcelain"]);
  if (res.code !== 0) fail(res.stderr, "git status failed");
  const entries: StatusEntry[] = [];
  // Do NOT trim the whole output: an unstaged-only line begins with a space
  // (" M path"); a leading trim would eat the XY column and corrupt the path.
  for (const line of res.stdout.split("\n")) {
    if (line.length < 4) continue; // blank or too short to carry a path
    const x = line[0];
    const y = line[1];
    let p = line.slice(3).trim(); // drop the 2-char XY code + separator
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4).trim(); // rename: take the destination
    // Strip surrounding quotes git adds for paths with special chars.
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p) entries.push({ x, y, path: p });
  }
  return { raw: res.stdout, entries };
}

/**
 * `git diff`. `cached` diffs the index; `stat`/`nameOnly` choose the summary
 * form; `paths` are passed after `--` so they're treated as pathspecs.
 */
export async function diff(
  root: string,
  opts?: { cached?: boolean; stat?: boolean; nameOnly?: boolean; paths?: string[] },
): Promise<string> {
  const args = ["diff"];
  if (opts?.cached) args.push("--cached");
  if (opts?.stat) args.push("--stat");
  if (opts?.nameOnly) args.push("--name-only");
  if (opts?.paths?.length) args.push("--", ...opts.paths);
  const res = await gitExec(root, args);
  if (res.code !== 0) fail(res.stderr, "git diff failed");
  return res.stdout;
}

/**
 * `git log`. `oneline` uses the compact form; `n` limits commit count;
 * `format` sets an explicit `--pretty=format:` template.
 */
export async function log(
  root: string,
  opts?: { oneline?: boolean; n?: number; format?: string },
): Promise<string> {
  const args = ["log"];
  if (opts?.oneline) args.push("--oneline");
  if (typeof opts?.n === "number") args.push(`--max-count=${opts.n}`);
  if (opts?.format) args.push(`--pretty=format:${opts.format}`);
  const res = await gitExec(root, args);
  if (res.code !== 0) fail(res.stderr, "git log failed");
  return res.stdout;
}

/** `git show [<ref>]`. */
export async function show(root: string, ref?: string): Promise<string> {
  const args = ["show"];
  if (ref) args.push(ref);
  const res = await gitExec(root, args);
  if (res.code !== 0) fail(res.stderr, "git show failed");
  return res.stdout;
}

/** `git branch --list` — local branch names, trimmed, with the leading "* " stripped. */
export async function listBranches(root: string): Promise<string[]> {
  const res = await gitExec(root, ["branch", "--list"]);
  if (res.code !== 0) fail(res.stderr, "git branch --list failed");
  return res.stdout
    .split("\n")
    .map((l) => l.replace(/^\*?\s+/, "").trim()) // strip "* " current marker + indent
    .filter(Boolean);
}

/** `git ls-files` — tracked files, optionally limited to `paths` (after `--`). */
export async function lsFiles(root: string, paths?: string[]): Promise<string[]> {
  const args = ["ls-files"];
  if (paths?.length) args.push("--", ...paths);
  const res = await gitExec(root, args);
  if (res.code !== 0) fail(res.stderr, "git ls-files failed");
  return lines(res.stdout);
}

/** `git rev-parse <ref>` — the resolved SHA as a single trimmed line. */
export async function revParse(root: string, ref: string): Promise<string> {
  const res = await gitExec(root, ["rev-parse", ref]);
  if (res.code !== 0) fail(res.stderr, `git rev-parse ${ref} failed`);
  return res.stdout.trim();
}

/** `git rev-list --count <range>` — the number of commits in `range`. */
export async function revListCount(root: string, range: string): Promise<number> {
  const res = await gitExec(root, ["rev-list", "--count", range]);
  if (res.code !== 0) fail(res.stderr, `git rev-list --count ${range} failed`);
  return Number.parseInt(res.stdout.trim(), 10);
}

/** `git blame -- <file>`, optionally limited to a line `range` (`-L`). */
export async function blame(
  root: string,
  file: string,
  opts?: { range?: string },
): Promise<string> {
  const args = ["blame"];
  if (opts?.range) args.push("-L", opts.range);
  args.push("--", file);
  const res = await gitExec(root, args);
  if (res.code !== 0) fail(res.stderr, `git blame ${file} failed`);
  return res.stdout;
}
