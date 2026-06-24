/**
 * Native git core — typed MUTATING (state-changing) wrappers.
 *
 * Each wrapper builds its argv ONLY from typed options and runs it through
 * `gitExec` with `{ mutating: true }` so a future gating/policy layer can
 * intercept state changes. Value-returning wrappers (`commit`) throw on a
 * non-zero exit (surfacing stderr); action wrappers (`add`/`restore`/`reset`)
 * throw on failure too so callers don't silently proceed on an error.
 *
 * Never adds `--force`; a caller must pass any forcing flag explicitly.
 */
import { gitExec, type GitArgs, type GitExecResult } from "./core.js";

/** Throw a useful error from a non-zero `gitExec` result. */
function fail(args: GitArgs, res: GitExecResult): never {
  throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed (code ${res.code})`);
}

/** Run a mutating git command, throwing on a non-zero exit. */
async function runMutating(root: string, args: GitArgs): Promise<GitExecResult> {
  const res = await gitExec(root, args, { mutating: true });
  if (res.code !== 0) fail(args, res);
  return res;
}

/**
 * Stage changes. `all` runs `git add -A` (stage every change, tracked and
 * untracked, including deletions); otherwise stages the given `paths`.
 * Exactly one of `all` or a non-empty `paths` must be provided.
 */
export async function add(root: string, opts: { all?: boolean; paths?: string[] }): Promise<void> {
  if (opts.all) {
    await runMutating(root, ["add", "-A"]);
    return;
  }
  if (!opts.paths?.length) {
    throw new Error("git add: provide { all: true } or a non-empty paths[]");
  }
  // `--` ensures paths are treated as pathspecs, never as options.
  await runMutating(root, ["add", "--", ...opts.paths]);
}

/**
 * Restore working-tree (and optionally index) entries. With `staged: true`,
 * unstages the paths (`git restore --staged`); otherwise discards working-tree
 * changes for them. `paths` is required.
 */
export async function restore(root: string, opts: { staged?: boolean; paths: string[] }): Promise<void> {
  if (!opts.paths?.length) {
    throw new Error("git restore: paths[] is required");
  }
  const args: GitArgs = ["restore"];
  if (opts.staged) args.push("--staged");
  args.push("--", ...opts.paths);
  await runMutating(root, args);
}

/** Extract the short hash from a `git commit` summary line "[branch <hash>] ...". */
function parseCommitHash(stdout: string): string | undefined {
  return stdout.match(/\[[^\]]*?\s([0-9a-f]+)\]/)?.[1];
}

/**
 * Record staged changes as a commit. `amend` rewrites HEAD; `noEdit` keeps the
 * existing message (useful with `amend`). A `message` is required unless
 * `noEdit` (or `amend` with `noEdit`) supplies one. Returns the new short hash
 * parsed from git's summary line (absent only if git emitted no summary).
 */
export async function commit(
  root: string,
  opts: { message?: string; amend?: boolean; noEdit?: boolean },
): Promise<{ hash?: string }> {
  const args: GitArgs = ["commit"];
  if (opts.amend) args.push("--amend");
  if (opts.noEdit) args.push("--no-edit");
  if (opts.message !== undefined) args.push("-m", opts.message);
  if (opts.message === undefined && !opts.noEdit) {
    throw new Error("git commit: provide a message or set noEdit");
  }
  const res = await runMutating(root, args);
  return { hash: parseCommitHash(res.stdout) };
}

/**
 * Reset the index/HEAD. With `paths`, unstages those pathspecs (mixed reset of
 * paths). Otherwise resets to `ref` (default HEAD) with `--soft` (move HEAD,
 * keep index + working tree) or `--mixed` (move HEAD, reset index, keep working
 * tree). `--mixed` is git's default when neither flag is given. Never `--hard`.
 */
export async function reset(
  root: string,
  opts: { soft?: boolean; mixed?: boolean; ref?: string; paths?: string[] },
): Promise<void> {
  if (opts.paths?.length) {
    // Path-form reset cannot take --soft/--mixed; it's always a mixed unstage.
    const args: GitArgs = ["reset"];
    if (opts.ref) args.push(opts.ref);
    args.push("--", ...opts.paths);
    await runMutating(root, args);
    return;
  }
  const args: GitArgs = ["reset"];
  if (opts.soft) args.push("--soft");
  else if (opts.mixed) args.push("--mixed");
  if (opts.ref) args.push(opts.ref);
  await runMutating(root, args);
}
