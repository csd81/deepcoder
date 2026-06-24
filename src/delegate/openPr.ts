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

const execFileAsync = promisify(execFile);

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
  await execFileAsync("git", ["push", "-u", "origin", branch], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });

  // 2. Write body to a temp file (avoid argv quoting issues).
  const bodyFile = path.join(root, `.prbody-${branch}`);
  await fs.writeFile(bodyFile, body, "utf-8");

  // 3. Open PR — never merge.
  const runGh = opts.runGh ?? defaultRunGh;
  const url = await runGh([
    "pr", "create",
    "--base", base,
    "--head", branch,
    "--title", `[delegated] ${branch}`,
    "--body-file", bodyFile,
  ]);

  // Clean up temp body file.
  await fs.rm(bodyFile, { force: true });

  return url.trim();
}

/* ------------------------------------------------------------------ */
/*  prepareWorkerBranch — create branch, apply patch, commit           */
/* ------------------------------------------------------------------ */

export interface PrepareWorkerBranchOpts {
  /** Branch name to create. */
  branch: string;
  /** Base ref to branch off (default: master). */
  base?: string;
}

/**
 * Create a NEW branch off `base`, apply the worker's `patch.diff`, and commit.
 * Uses a temporary git worktree so the current branch and working tree are never
 * touched. Returns the branch name.
 *
 * The branch exists in the repo after this call; an `openPr` on it will push and
 * open a PR. Master/base is never modified.
 */
export async function prepareWorkerBranch(
  root: string,
  planId: string,
  workerId: string,
  opts: PrepareWorkerBranchOpts,
): Promise<string> {
  const base = opts.base ?? "master";
  const patchFile = path.join(
    root, ".deepcoder", "delegations", planId, "runs", workerId, "patch.diff",
  );

  // Create a temporary worktree on a new branch off base.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "deleg-pr-"));
  const wt = path.join(tmpDir, "wt");

  try {
    await execFileAsync("git", ["worktree", "add", wt, "-b", opts.branch, base], {
      cwd: root,
    });

    // Apply the worker's patch in the worktree (never touches real root).
    await execFileAsync("git", ["apply", "--check", "--whitespace=nowarn", patchFile], {
      cwd: wt,
    });
    await execFileAsync("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: wt,
    });

    // Commit on the branch.
    await execFileAsync("git", ["add", "-A"], { cwd: wt });
    await execFileAsync("git", [
      "-c", "commit.gpgsign=false", "commit", "-qm",
      `feat: delegated worker result (${opts.branch})

Produced by a deepcoder worker via --solve --check phase.
NOT yet human-verified — see the PR review checklist.

Co-Authored-By: deepcoder-worker <noreply@deepcoder.local>`,
    ], { cwd: wt });
  } finally {
    // Clean up the temp worktree (the branch retains the commit).
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", wt], { cwd: root });
      await execFileAsync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* best-effort */
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return opts.branch;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function defaultRunGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
