/**
 * Native git core — typed remote-interaction wrappers.
 *
 * Part of Phase 0 of plans/new/feat-native-git-core-plan.md: deepcoder owns git
 * deterministically. These wrappers build the arg array ONLY from typed options and
 * call `gitExec` rather than the AI emitting `git push`/`git clean` shell commands.
 *
 * SAFETY-CRITICAL invariant: never add `--force` to push, and never actually delete
 * untracked files on `clean`, unless the caller explicitly opts in (`force: true`).
 * State-changing ops are flagged `{ mutating: true }`; read-only listing runs free.
 */
import { gitExec, type GitArgs, type GitExecResult } from "./core.js";

export interface FetchOpts {
  remote?: string;
}

export interface PullOpts {
  ffOnly?: boolean;
  rebase?: boolean;
}

export interface PushOpts {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  delete?: boolean;
  /** Only when `true` is `--force` added to the push. */
  force?: boolean;
}

export interface CleanOpts {
  /** Defaults to a dry run (`-n`); only an actual delete (`-f`) when `force` is true. */
  dryRun?: boolean;
  force?: boolean;
  directories?: boolean;
}

/**
 * Pure: build the `git push` arg array from typed options. Exported so a test can
 * assert flag presence without a network. `--force` is present ONLY when force === true.
 */
export function buildPushArgs(opts: PushOpts = {}): GitArgs {
  const args: GitArgs = ["push"];
  if (opts.force === true) args.push("--force");
  if (opts.setUpstream === true) args.push("--set-upstream");
  if (opts.delete === true) args.push("--delete");
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  return args;
}

/**
 * Pure: build the `git clean` arg array from typed options. Defaults to `-n` (dry run);
 * `-f` is present ONLY when force === true. Exported for argument-shape testing.
 */
export function buildCleanArgs(opts: CleanOpts = {}): GitArgs {
  const args: GitArgs = ["clean"];
  if (opts.force === true) {
    args.push("-f");
  } else {
    args.push("-n");
  }
  if (opts.directories === true) args.push("-d");
  return args;
}

/** `git fetch [remote]` — state-changing (updates remote-tracking refs). */
export function fetch(root: string, opts: FetchOpts = {}): Promise<GitExecResult> {
  const args: GitArgs = ["fetch"];
  if (opts.remote) args.push(opts.remote);
  return gitExec(root, args, { mutating: true });
}

/** `git pull [--ff-only] [--rebase]` — state-changing. */
export function pull(root: string, opts: PullOpts = {}): Promise<GitExecResult> {
  const args: GitArgs = ["pull"];
  if (opts.ffOnly === true) args.push("--ff-only");
  if (opts.rebase === true) args.push("--rebase");
  return gitExec(root, args, { mutating: true });
}

/** `git push …` — state-changing. `--force` ONLY when `force === true` (see buildPushArgs). */
export function push(root: string, opts: PushOpts = {}): Promise<GitExecResult> {
  return gitExec(root, buildPushArgs(opts), { mutating: true });
}

/** `git remote -v` — read-only listing (runs free). */
export async function listRemotes(root: string): Promise<string> {
  const res = await gitExec(root, ["remote", "-v"]);
  return res.stdout;
}

/** `git remote get-url <name>` — read-only, trimmed. */
export async function getRemoteUrl(root: string, name: string): Promise<string> {
  const res = await gitExec(root, ["remote", "get-url", name]);
  return res.stdout.trim();
}

/**
 * `git clean` — DEFAULTS to `-n` (dry run); only `-f` (an actual delete) when
 * `force === true`. State-changing only when it actually deletes; the dry-run form
 * touches nothing, but we flag mutating so a gating layer can prompt on the real delete.
 */
export function clean(root: string, opts: CleanOpts = {}): Promise<GitExecResult> {
  const args = buildCleanArgs(opts);
  const isMutating = opts.force === true;
  return gitExec(root, args, { mutating: isMutating });
}
