/**
 * finalizeToBranch — the copy-on-write session finalize. Instead of applying an
 * isolated worktree's patch back onto the user's checkout, commit it onto a NEW
 * branch off the user's current branch and (when a remote exists) open a PR.
 *
 * This is the shared hinge used by both the single-session lifecycle
 * (finalizeIsolation) and, via prepareBranch/openPr, the delegate worker path.
 * It NEVER touches the base branch's working tree and NEVER merges — the PR (or
 * the local branch) is the review gate an architect acts on.
 */
import { gitExec } from "../git/core.js";
import { listRemotes } from "../git/remote.js";
import { prepareBranch, openPr } from "../delegate/openPr.js";
import type { IsolatedWorkspace } from "./types.js";

export interface FinalizeToBranchResult {
  /** Number of files changed in the worktree (0 ⇒ nothing was committed). */
  changedFiles: number;
  /** Branch that holds the commit, or null when there were no changes. */
  branch: string | null;
  /** Whether a commit was made on the branch. */
  committed: boolean;
  /** PR url, present only when a PR was successfully opened. */
  prUrl?: string;
  /** True ⇒ the committed branch was left locally (no remote, or PR failed). */
  localOnly: boolean;
}

export interface FinalizeToBranchOpts {
  /** The real workspace root (the user's checkout). */
  realRoot: string;
  /** Branch name to create (caller-derived, e.g. `deepcoder/<session-id>`). */
  branch: string;
  /** Base ref to branch off. Default: the real root's current branch (or HEAD sha if detached). */
  base?: string;
  /** Commit message for the single commit on the branch. */
  commitMessage: string;
  /** PR body used when a PR is opened. */
  prBody: string;
  /** Seam over `gh` for tests (defaults to spawning a real `gh`). */
  runGh?: (args: string[]) => Promise<string>;
  /** Seam over `git remote -v` for tests. */
  listRemotesFn?: (root: string) => Promise<string>;
}

/**
 * Detect the base ref to branch off: the real root's current branch, falling
 * back to the HEAD commit sha when in detached-HEAD state (where `--abbrev-ref
 * HEAD` yields the literal "HEAD", which is ambiguous for `git worktree add`).
 */
async function detectBase(realRoot: string): Promise<string> {
  const abbrev = await gitExec(realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = abbrev.stdout.trim();
  if (name && name !== "HEAD") return name;
  const sha = await gitExec(realRoot, ["rev-parse", "HEAD"]);
  return sha.stdout.trim();
}

export async function finalizeToBranch(
  ws: IsolatedWorkspace,
  opts: FinalizeToBranchOpts,
): Promise<FinalizeToBranchResult> {
  const changed = await ws.changedFiles();
  if (changed.length === 0) {
    return { changedFiles: 0, branch: null, committed: false, localOnly: false };
  }

  const base = opts.base ?? (await detectBase(opts.realRoot));
  const patch = await ws.diff();

  // Create + commit the branch in a temp worktree off base. Never touches the
  // user's checkout. Throws on a genuine git failure (propagated to the caller).
  await prepareBranch(opts.realRoot, {
    branch: opts.branch,
    base,
    patch,
    commitMessage: opts.commitMessage,
  });

  // Remote detection — empty `git remote -v` ⇒ local-only (no PR possible).
  const remotes = (await (opts.listRemotesFn ?? listRemotes)(opts.realRoot)).trim();
  if (!remotes) {
    return { changedFiles: changed.length, branch: opts.branch, committed: true, localOnly: true };
  }

  // With a remote: push + open a PR. Any failure (no `gh`, no auth, rejected
  // push) falls back to local-only — the branch is already committed locally and
  // is never lost.
  try {
    const prUrl = await openPr(opts.prBody, {
      root: opts.realRoot,
      branch: opts.branch,
      base,
      runGh: opts.runGh,
    });
    return { changedFiles: changed.length, branch: opts.branch, committed: true, prUrl, localOnly: false };
  } catch {
    return { changedFiles: changed.length, branch: opts.branch, committed: true, localOnly: true };
  }
}
