/**
 * openPr — commit uncommitted changes, push, and open a PR via `gh pr create`.
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
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface OpenPrOpts {
  root: string;
  branch?: string;
  base?: string;
  /** Seam over `gh` (default: spawn a real `gh` process). */
  runGh?: (args: string[]) => Promise<string>;
}

/**
 * Commit any uncommitted changes on the current branch, push, then open a PR
 * via `gh pr create`. Returns the PR url.
 *
 * - Uses `git add -A` to stage everything (the caller has already validated
 *   the patch scope, so this is safe).
 * - Never merges — the PR is the review gate.
 * - `runGh` is injectable for testing; defaults to spawning `gh`.
 */
export async function openPr(
  body: string,
  opts: OpenPrOpts,
): Promise<string> {
  const { root, base = "master" } = opts;
  const cwd = root;

  // Resolve the current branch name (CLI caller passes it or we discover it).
  const branch = opts.branch ?? (await gitBranch(cwd));

  // 1. Commit (no-op if clean).
  const status = await gitStatus(cwd);
  if (status) {
    await execFileAsync("git", ["add", "-A"], { cwd });
    await execFileAsync("git", [
      "commit", "-q", "-m",
      `feat: delegated worker result (${branch})

Produced by a deepcoder worker via --solve --check phase.
NOT yet human-verified — see the PR review checklist.

Co-Authored-By: deepcoder-worker <noreply@deepcoder.local>`,
    ], { cwd, maxBuffer: 8 * 1024 * 1024 });
  }

  // 2. Push.
  await execFileAsync("git", ["push", "-u", "origin", branch], { cwd, maxBuffer: 8 * 1024 * 1024 });

  // 3. Write body to a temp file (avoid argv quoting issues).
  const bodyFile = path.join(root, `.prbody-${branch}`);
  await fs.writeFile(bodyFile, body, "utf-8");

  // 4. Open PR — never merge.
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

async function gitBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout.trim();
}

async function defaultRunGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
