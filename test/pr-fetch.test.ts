import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/workspace/git.js";
import { fetchPr, getPrDiff, type PrInfo } from "../src/cli/prFetch.js";

const exec = promisify(execFile);

/**
 * Create a pair of bare + clone repos that simulate a GitHub remote with a PR.
 *
 * Remote bare repo layout:
 *   - main:  "base content"
 *   - refs/pull/42/head: "PR content" (child of main)
 *
 * The clone (workspace) is on main and has the remote set to the bare repo.
 *
 * Strategy: seed a bare repo from a temporary working tree, then clone it
 * for the workspace.  Cloning an *empty* bare repo doesn't produce a local
 * "main" branch, so we seed it first.
 */
async function setupPrFixture(): Promise<{
  workspaceRoot: string;
  remoteUrl: string;
  cleanup: () => Promise<void>;
}> {
  const remoteDir = await mkdtemp(path.join(tmpdir(), "pr-fetch-remote-"));
  const seedDir = await mkdtemp(path.join(tmpdir(), "pr-fetch-seed-"));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "pr-fetch-ws-"));

  const dirs = [remoteDir, seedDir, workspaceDir];
  const cleanup = async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  };

  try {
    // Init bare remote
    await exec("git", ["init", "-q", "--bare", remoteDir]);

    // Seed the bare repo by creating content in seedDir, committing, and pushing
    await exec("git", ["init", "-q", "-b", "main"], { cwd: seedDir });
    await exec("git", ["config", "user.email", "t@t"], { cwd: seedDir });
    await exec("git", ["config", "user.name", "t"], { cwd: seedDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: seedDir });
    await writeFile(path.join(seedDir, "base.txt"), "base content\n");
    await exec("git", ["add", "-A"], { cwd: seedDir });
    await exec("git", ["commit", "-qm", "base commit"], { cwd: seedDir });
    await exec("git", ["remote", "add", "origin", remoteDir], { cwd: seedDir });
    await exec("git", ["push", "-q", "origin", "main"], { cwd: seedDir });
    // Point the BARE remote's HEAD at main. `git init --bare` left HEAD on the
    // system default (e.g. master); without this the clone below gets an unborn
    // HEAD and `rev-parse --abbrev-ref HEAD` / `diff HEAD HEAD` throw "ambiguous
    // argument 'HEAD'". This is the env-dependent flake the worker missed.
    await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remoteDir });
    // Set HEAD to main (simulate GitHub's default branch pointer)
    await exec("git", ["remote", "set-head", "origin", "main"], { cwd: seedDir });

    // Create PR content: a commit on top of main
    await writeFile(path.join(seedDir, "pr-file.txt"), "pr change\n");
    await exec("git", ["add", "-A"], { cwd: seedDir });
    await exec("git", ["commit", "-qm", "pr commit"], { cwd: seedDir });

    // Get the commit hash
    const { stdout: commitHash } = await exec("git", ["rev-parse", "HEAD"], { cwd: seedDir });

    // Push the commit directly as pull/42/head (simulating GitHub's ref)
    await exec("git", ["push", "-q", "origin", `${commitHash.trim()}:refs/pull/42/head`], { cwd: seedDir });

    // Now clone the (non-empty) bare repo for the workspace
    await exec("git", ["clone", "-q", remoteDir, workspaceDir]);
    await exec("git", ["config", "user.email", "t@t"], { cwd: workspaceDir });
    await exec("git", ["config", "user.name", "t"], { cwd: workspaceDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: workspaceDir });
    // Ensure origin/HEAD is set so resolveBaseRef can find it
    await exec("git", ["remote", "set-head", "origin", "main"], { cwd: workspaceDir });

    return { workspaceRoot: workspaceDir, remoteUrl: remoteDir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

test("fetchPr builds the correct refspec and returns base/head refs", async () => {
  const { workspaceRoot, cleanup } = await setupPrFixture();
  try {
    const info = await fetchPr(42, { workspaceRoot });

    // The PR branch was created locally
    assert.equal(info.prBranch, "pr/42");
    assert.equal(info.headRef, "pr/42");

    // baseRef should be origin/main (resolved from origin/HEAD)
    assert.equal(info.baseRef, "origin/main");

    // Verify the local branch exists (the PR ref was fetched as pr/42)
    const git = new Git(workspaceRoot);
    const branches = await git.branches();
    assert.ok(branches.local.includes("pr/42"), `pr/42 should be a local branch; got: ${branches.local.join(", ")}`);

    // The PR commit message should be reachable via the pr/42 ref
    const { stdout: prMsg } = await exec("git", ["log", "--oneline", "-1", "pr/42"], { cwd: workspaceRoot });
    assert.match(prMsg, /pr commit/, "PR commit should be reachable via pr/42");
  } finally {
    await cleanup();
  }
});

test("getPrDiff returns the diff between base and PR branch", async () => {
  const { workspaceRoot, cleanup } = await setupPrFixture();
  try {
    const info = await fetchPr(42, { workspaceRoot });
    const git = new Git(workspaceRoot);
    const diff = await getPrDiff(git, info);

    // The diff should contain the PR change but not the base content
    assert.match(diff, /pr-file\.txt/, "diff should reference the PR file");
    assert.match(diff, /pr change/, "diff should contain the PR change");
    // The base content should NOT appear in the diff (it's from before the PR)
    assert.doesNotMatch(diff, /base content/, "diff should not contain base content");
  } finally {
    await cleanup();
  }
});

test("fetchPr throws on non-git directory", async () => {
  const nonGitDir = await mkdtemp(path.join(tmpdir(), "pr-fetch-nongit-"));
  try {
    await assert.rejects(
      () => fetchPr(42, { workspaceRoot: nonGitDir }),
      /Not a git repository/,
    );
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }
});

test("fetchPr throws on missing remote (no origin)", async () => {
  const bareRepo = await mkdtemp(path.join(tmpdir(), "pr-fetch-noremote-"));
  try {
    // Init a non-bare repo with no remotes
    await exec("git", ["init", "-q", "-b", "main"], { cwd: bareRepo });
    await exec("git", ["config", "user.email", "t@t"], { cwd: bareRepo });
    await exec("git", ["config", "user.name", "t"], { cwd: bareRepo });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: bareRepo });
    await writeFile(path.join(bareRepo, "f.txt"), "x\n");
    await exec("git", ["add", "-A"], { cwd: bareRepo });
    await exec("git", ["commit", "-qm", "init"], { cwd: bareRepo });

    // The repo exists but has no remote, so git fetch will fail
    await assert.rejects(
      () => fetchPr(42, { workspaceRoot: bareRepo }),
      (err: unknown) => {
        const msg = (err as Error).message;
        // The error must NOT be "Not a git repository" — we want to verify
        // that isRepo() passed but fetch failed.
        assert.ok(!msg.includes("Not a git repository"), "must pass isRepo check");
        return true; // any fetch-related error is acceptable
      },
    );
  } finally {
    await rm(bareRepo, { recursive: true, force: true });
  }
});

test("fetchPr with custom remote name", async () => {
  const { workspaceRoot, remoteUrl, cleanup } = await setupPrFixture();
  try {
    // Add a second remote "upstream" pointing to the same remote
    const git = new Git(workspaceRoot);
    // We need to add the remote and fetch it
    await exec("git", ["remote", "add", "upstream", remoteUrl], { cwd: workspaceRoot });
    await exec("git", ["fetch", "-q", "upstream"], { cwd: workspaceRoot });
    // Set HEAD on upstream too
    await exec("git", ["remote", "set-head", "upstream", "main"], { cwd: workspaceRoot });

    const info = await fetchPr(42, { remote: "upstream", workspaceRoot });

    assert.equal(info.baseRef, "upstream/main");
    assert.equal(info.prBranch, "pr/42");

    const diff = await getPrDiff(git, info);
    assert.match(diff, /pr change/, "diff should exist with custom remote");
  } finally {
    await cleanup();
  }
});

test("getPrDiff returns empty string for identical refs", async () => {
  const { workspaceRoot, cleanup } = await setupPrFixture();
  try {
    // Create a PrInfo where base and head are the same
    const info: PrInfo = {
      baseRef: "HEAD",
      headRef: "HEAD",
      prBranch: "pr/0",
    };
    const git = new Git(workspaceRoot);
    const diff = await getPrDiff(git, info);
    assert.equal(diff, "");
  } finally {
    await cleanup();
  }
});
