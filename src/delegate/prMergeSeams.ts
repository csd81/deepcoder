/**
 * Real seam implementations for mergePr — each factory takes injectable
 * runGh/runGit so tests can swap them for fakes (no real gh/git needed).
 *
 * validate: gh pr view <pr> --json state,mergeable,statusCheckRollup
 * conflicts: git merge-tree $(merge-base) base head → conflicted files
 * merge: gh pr merge <pr> --merge --delete-branch + post-merge cleanup
 * resolve: OUT OF SCOPE — if conflicts exist, do NOT merge.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExec } from "../git/core.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunGh = (args: string[]) => Promise<RunResult>;
export type RunGit = (args: string[], opts?: { cwd?: string }) => Promise<RunResult>;
export type Sleep = (ms: number) => Promise<void>;

/* ------------------------------------------------------------------ */
/*  Default sleep (real setTimeout) — swapped in tests                 */
/* ------------------------------------------------------------------ */

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/*  Default runGh / runGit (spawn real binaries)                      */
/* ------------------------------------------------------------------ */

export async function defaultRunGh(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function defaultRunGit(args: string[], opts?: { cwd?: string }): Promise<RunResult> {
  // Route through the native git core (the single deterministic git primitive)
  // rather than spawning git directly. gitExec never throws on a non-zero exit,
  // so the {code, stdout, stderr} shape maps straight onto RunResult.
  const res = await gitExec(opts?.cwd ?? process.cwd(), args);
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
}

/* ------------------------------------------------------------------ */
/*  validate(pr) — is the PR structurally applyable?                   */
/* ------------------------------------------------------------------ */

/**
 * gh pr view <pr> --json state,mergeable,mergeStateStatus,statusCheckRollup →
 * applyable iff state=OPEN && mergeable=MERGEABLE && no failing checks.
 *
 * When mergeable=UNKNOWN (GitHub computing mergeability async after the base
 * moves), retry up to 5 times with backoff (1s, 2s, 4s, 8s). Only PERSISTENT
 * non-MERGEABLE is a failure.
 */
export function createValidateSeam(runGh: RunGh, sleep: Sleep = defaultSleep) {
  return async (
    pr: number,
  ): Promise<{ applyable: boolean; failures: { code: string }[]; mergeStateStatus?: string }> => {
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await runGh([
        "pr",
        "view",
        String(pr),
        "--json",
        "state,mergeable,mergeStateStatus,statusCheckRollup",
      ]);

      if (result.exitCode !== 0) {
        return { applyable: false, failures: [{ code: "pr_view_failed" }] };
      }

      let data: {
        state?: string;
        mergeable?: string;
        mergeStateStatus?: string;
        statusCheckRollup?: Array<{ name?: string; conclusion?: string }>;
      };
      try {
        data = JSON.parse(result.stdout);
      } catch {
        return { applyable: false, failures: [{ code: "pr_view_parse_failed" }] };
      }

      // UNKNOWN: GitHub is still computing mergeability — retry with backoff.
      if (data.mergeable === "UNKNOWN" && attempt < maxAttempts - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      const failures: { code: string }[] = [];

      if (data.state !== "OPEN") {
        failures.push({ code: "pr_not_open" });
      }
      if (data.mergeable !== "MERGEABLE") {
        failures.push({ code: "pr_not_mergeable" });
      }

      for (const check of data.statusCheckRollup ?? []) {
        if (
          check.conclusion === "FAILURE" ||
          check.conclusion === "ACTION_REQUIRED" ||
          check.conclusion === "CANCELLED" ||
          check.conclusion === "TIMED_OUT"
        ) {
          failures.push({
            code: `check_${(check.name ?? "unknown").replace(/\s+/g, "_")}_${check.conclusion.toLowerCase()}`,
          });
        }
      }

      return { applyable: failures.length === 0, failures, mergeStateStatus: data.mergeStateStatus };
    }

    // Should not be reached, but satisfy the type checker.
    return { applyable: false, failures: [{ code: "pr_view_failed" }] };
  };
}

/* ------------------------------------------------------------------ */
/*  conflicts(branch, base) — list conflicting files via merge-tree    */
/* ------------------------------------------------------------------ */

/**
 * git merge-tree $(git merge-base <base> <branch>) <base> <branch>
 * Returns a list of conflicting file paths.
 */
export function createConflictsSeam(
  runGit: RunGit,
  opts: { branch: string; base: string },
) {
  return async (): Promise<string[]> => {
    const baseResult = await runGit(["merge-base", opts.base, opts.branch]);
    if (baseResult.exitCode !== 0) return [];
    const mergeBase = baseResult.stdout.trim();
    if (!mergeBase) return [];

    const treeResult = await runGit([
      "merge-tree",
      mergeBase,
      opts.base,
      opts.branch,
    ]);
    if (treeResult.exitCode !== 0) return [];

    return parseConflictedFiles(treeResult.stdout);
  };
}

/**
 * Parse `git merge-tree` output for conflicted file paths.
 * Conflict blocks start with "changed in both" and list file paths on
 * the "our"/"their" lines (4th whitespace-delimited field).
 */
function parseConflictedFiles(output: string): string[] {
  const files = new Set<string>();
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "changed in both") {
      // Next lines are "  base ...", "  our ...", "  their ..."
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = /^\s+(?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/.exec(
          lines[j],
        );
        if (m) {
          files.add(m[1]);
          break; // one file per conflict block
        }
      }
    }
  }
  return [...files];
}

/* ------------------------------------------------------------------ */
/*  update-branch — merge base into PR branch for behind-but-clean PRs  */
/* ------------------------------------------------------------------ */

/**
 * gh pr update-branch <pr> — merges the base branch into the PR branch.
 * For a PR that is behind master but NOT truly conflicting.
 */
export function createUpdateBranchSeam(runGh: RunGh) {
  return async (pr: number): Promise<{ ok: boolean; error?: string }> => {
    const result = await runGh(["pr", "update-branch", String(pr)]);
    return {
      ok: result.exitCode === 0,
      error: result.exitCode !== 0 ? result.stderr || undefined : undefined,
    };
  };
}

/* ------------------------------------------------------------------ */
/*  merge(pr) — gh pr merge + post-merge cleanup                       */
/* ------------------------------------------------------------------ */

/**
 * gh pr merge <pr> --merge --delete-branch, then post-merge cleanup
 * scoped to THIS branch's artifacts (NEVER blanket-rm).
 */
export function createMergeSeam(
  runGh: RunGh,
  runGit: RunGit,
  opts: { root: string },
) {
  return async (pr: number): Promise<void> => {
    // 1. Get the branch name so we can scope cleanup.
    const viewResult = await runGh([
      "pr",
      "view",
      String(pr),
      "--json",
      "headRefName",
    ]);
    let branch = "";
    if (viewResult.exitCode === 0) {
      try {
        const data = JSON.parse(viewResult.stdout);
        branch = data.headRefName ?? "";
      } catch {
        /* best-effort */
      }
    }

    // 2. Merge via gh.
    await runGh(["pr", "merge", String(pr), "--merge", "--delete-branch"]);

    // 3. Post-merge cleanup — scoped to this PR's artifacts.
    if (branch) {
      await cleanupLocalArtifacts(runGit, opts.root, branch);
    }
  };
}

/**
 * Scoped cleanup: this branch's local worktree/branch + /tmp/deleg-<branch>.*.
 * NEVER blanket-rm. Best-effort — failures are silently ignored.
 */
async function cleanupLocalArtifacts(
  runGit: RunGit,
  root: string,
  branch: string,
): Promise<void> {
  // Remove local worktree if it exists.
  const wtPath = `../deleg-${branch}`;
  try {
    await runGit(["worktree", "remove", "--force", wtPath], { cwd: root });
    await runGit(["worktree", "prune"], { cwd: root });
  } catch {
    /* best-effort */
  }

  // Remove local branch if it still exists.
  try {
    await runGit(["branch", "-D", branch], { cwd: root });
  } catch {
    /* best-effort */
  }

  // Sync local master + prune the now-deleted remote branch. `gh pr merge
  // --delete-branch` deletes the remote branch, but a plain fetch leaves the
  // stale `origin/<branch>` remote-tracking ref dangling locally — `--prune`
  // drops it so the local view matches the remote.
  try {
    await runGit(["fetch", "--prune", "origin"], { cwd: root });
    await runGit(["merge", "--ff-only", "origin/master"], { cwd: root });
  } catch {
    /* best-effort */
  }

  // Drop this run's temp files: /tmp/deleg-<branch>.log{,.exit,.pr,.prbody}
  const tmpRoot = tmpdir();
  for (const suffix of [".log", ".log.exit", ".log.pr", ".log.prbody"]) {
    try {
      await rm(path.join(tmpRoot, `deleg-${branch}${suffix}`), {
        force: true,
      });
    } catch {
      /* best-effort */
    }
  }
}
