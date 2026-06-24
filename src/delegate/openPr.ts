/**
 * openPr — prepare a worker's patch on a new branch, push, and open a PR via `gh pr create`.
 *
 * Ported from scripts/delegate-finish.sh. This is the side-effect hinge for
 * `deepcoder delegate pr` — it is NEVER called without the caller first
 * confirming the worker is applyable.
 *
 * Inject a `runGh` seam in tests so no real `gh` binary is needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExec } from "../git/core.js";

const execFileAsync = promisify(execFile);

/** Run git through the native core; throw on non-zero so callers can rely on it. */
async function git(cwd: string, args: string[]): Promise<string> {
  const res = await gitExec(cwd, args);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `git ${args.join(" ")} failed (code ${res.code})`);
  }
  return res.stdout;
}

export interface OpenPrOpts {
  root: string;
  /** The branch to push and open a PR for (required — never the current branch). */
  branch: string;
  base?: string;
  /** Seam over `gh` (default: spawn a real `gh` process). */
  runGh?: (args: string[]) => Promise<string>;
}

/**
 * Push the already-prepared branch and open a PR via `gh pr create`.
 * Returns the PR url.
 *
 * - Does NOT commit or touch the current branch — the caller must have already
 *   prepared the branch via `prepareWorkerBranch`.
 * - Never merges — the PR is the review gate.
 * - `runGh` is injectable for testing; defaults to spawning `gh`.
 */
export async function openPr(
  body: string,
  opts: OpenPrOpts,
): Promise<string> {
  const { root, branch, base = "master" } = opts;

  // 1. Push the prepared branch.
  await git(root, ["push", "-u", "origin", branch]);

  // 2. Write body to a temp file (avoid argv quoting issues). Use a temp dir so a
  // branch name containing "/" (e.g. deepcoder/<id>) can't escape into the repo.
  const bodyDir = await mkdtemp(path.join(tmpdir(), "pr-body-"));
  const bodyFile = path.join(bodyDir, "body.md");
  await fs.writeFile(bodyFile, body, "utf-8");

  try {
    // 3. Open PR — never merge.
    const runGh = opts.runGh ?? defaultRunGh;
    const url = await runGh([
      "pr", "create",
      "--base", base,
      "--head", branch,
      "--title", `[delegated] ${branch}`,
      "--body-file", bodyFile,
    ]);
    return url.trim();
  } finally {
    await rm(bodyDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/*  prepareWorkerBranch — create branch, apply patch, commit           */
/* ------------------------------------------------------------------ */

export interface PrepareBranchOpts {
  /** Branch name to create. */
  branch: string;
  /** Base ref to branch off (default: master). */
  base?: string;
  /** A unified diff to apply. Mutually exclusive with patchFile. */
  patch?: string;
  /** Absolute path to a patch file to apply. Mutually exclusive with patch. */
  patchFile?: string;
  /** Commit message for the single commit on the branch. */
  commitMessage: string;
}

/**
 * Create a NEW branch off `base`, apply a patch (inline string or file), and
 * commit. Uses a temporary git worktree so the current branch and working tree
 * are never touched. Returns the branch name.
 *
 * The branch exists in the repo after this call; an `openPr` on it will push and
 * open a PR. Base (master/current branch) is never modified. An empty patch is a
 * no-op apply (the commit will simply contain no changes).
 */
export async function prepareBranch(root: string, opts: PrepareBranchOpts): Promise<string> {
  const base = opts.base ?? "master";
  if (!opts.patch && !opts.patchFile) {
    throw new Error("prepareBranch requires either patch or patchFile.");
  }

  // Create a temporary worktree on a new branch off base.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "deleg-pr-"));
  const wt = path.join(tmpDir, "wt");
  // When given an inline patch, materialize it inside the temp dir.
  const patchFile = opts.patchFile ?? path.join(tmpDir, "branch.patch");

  try {
    if (!opts.patchFile) await fs.writeFile(patchFile, opts.patch ?? "", "utf-8");

    await git(root, ["worktree", "add", wt, "-b", opts.branch, base]);

    // Apply the patch in the worktree (never touches real root). Skip for an
    // empty patch — `git apply` errors on a zero-length input.
    if ((opts.patch ?? "").trim() || opts.patchFile) {
      await git(wt, ["apply", "--check", "--whitespace=nowarn", patchFile]);
      await git(wt, ["apply", "--whitespace=nowarn", patchFile]);
    }

    // Commit on the branch.
    await git(wt, ["add", "-A"]);
    await git(wt, [
      "-c", "commit.gpgsign=false", "commit", "-qm", opts.commitMessage,
    ]);
  } finally {
    // Clean up the temp worktree (the branch retains the commit).
    try {
      await git(root, ["worktree", "remove", "--force", wt]);
      await git(root, ["worktree", "prune"]);
    } catch {
      /* best-effort */
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return opts.branch;
}

export interface PrepareWorkerBranchOpts {
  /** Branch name to create. */
  branch: string;
  /** Base ref to branch off (default: master). */
  base?: string;
}

/**
 * Create a NEW branch off `base`, apply the worker's `patch.diff`, and commit.
 * Thin wrapper over `prepareBranch` that resolves the delegation patch path and
 * the delegation commit message; the public signature is unchanged.
 */
export async function prepareWorkerBranch(
  root: string,
  planId: string,
  workerId: string,
  opts: PrepareWorkerBranchOpts,
): Promise<string> {
  const patchFile = path.join(
    root, ".deepcoder", "delegations", planId, "runs", workerId, "patch.diff",
  );
  return prepareBranch(root, {
    branch: opts.branch,
    base: opts.base,
    patchFile,
    commitMessage:
      `feat: delegated worker result (${opts.branch})

Produced by a deepcoder worker via --solve --check phase.
NOT yet human-verified — see the PR review checklist.

Co-Authored-By: deepcoder-worker <noreply@deepcoder.local>`,
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function defaultRunGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
