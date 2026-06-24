/**
 * Native git core — the single primitive every git module builds on.
 *
 * deepcoder owns git deterministically (Phase 0 of plans/new/feat-native-git-core-plan.md):
 * the typed wrappers in src/git/{read,commit,branch,integrate,remote}.ts all call `gitExec`
 * rather than the AI emitting `git` shell commands. State-changing ops are flagged via
 * `isMutatingGit` so a caller/policy can gate them; read-only ops run freely. Never adds
 * `--force` — a caller must pass it explicitly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitArgs = string[];

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Subcommands that never change repository state (safe to run un-gated). */
const READ_ONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "rev-list",
  "blame", "cat-file", "describe", "name-rev", "merge-base", "for-each-ref",
]);

/** Subcommands that change state (must be gated when run by/for an agent). */
const MUTATING = new Set([
  "add", "commit", "reset", "restore", "rm", "mv",
  "branch", "checkout", "switch", "tag", "worktree",
  "merge", "rebase", "stash", "cherry-pick", "revert", "apply",
  "push", "pull", "fetch", "remote", "clean", "gc", "prune",
]);

/**
 * Pure classifier: does this git invocation change repository state?
 * `branch`/`tag`/`remote` are mutating by default; a read-only listing form
 * (`branch --list`, `tag -l`, `remote -v`) is treated as read-only.
 */
export function isMutatingGit(args: GitArgs): boolean {
  const sub = args[0];
  if (!sub) return false;
  if (READ_ONLY.has(sub)) return false;
  if ((sub === "branch" || sub === "tag" || sub === "remote") &&
      args.some((a) => a === "--list" || a === "-l" || a === "-v" || a === "get-url")) {
    return false;
  }
  return MUTATING.has(sub);
}

/**
 * Run a git command in `root` and capture the result. Never throws on a non-zero
 * git exit — returns `{ code, stdout, stderr }` so callers decide. `opts.mutating`
 * lets a caller override the classifier (the value is exposed for a gating layer;
 * this primitive itself does not prompt — gating is the caller's responsibility).
 */
export async function gitExec(
  root: string,
  args: GitArgs,
  _opts?: { mutating?: boolean },
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}
