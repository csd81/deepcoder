import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIsolatedWorkspace } from "../src/workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../src/workspaceIsolation/types.js";
import { finalizeToBranch } from "../src/workspaceIsolation/finalizeToBranch.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ftb-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

/** Repo with a real bare remote named origin so `git push` succeeds in tests. */
async function makeRepoWithRemote(): Promise<{ root: string; bare: string }> {
  const root = await makeRepo();
  const bare = await mkdtemp(path.join(tmpdir(), "ftb-bare-"));
  git(bare, "init", "--bare", "-q");
  git(root, "remote", "add", "origin", bare);
  return { root, bare };
}

const opts = (over: object) => ({
  commitMessage: "deepcoder session test",
  prBody: "body",
  ...over,
});

test("no changes ⇒ no branch, nothing committed", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" });
  try {
    const res = await finalizeToBranch(ws, opts({ realRoot: root, branch: "deepcoder/s1" }));
    assert.equal(res.changedFiles, 0);
    assert.equal(res.branch, null);
    assert.equal(res.committed, false);
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("changes + remote + gh ⇒ opens a PR with detected base, never merges", async () => {
  const { root, bare } = await makeRepoWithRemote();
  const base = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const ws = await createIsolatedWorkspace(root, { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" });
  const ghCalls: string[][] = [];
  try {
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "isolated change\n", "utf8");
    const res = await finalizeToBranch(
      ws,
      opts({
        realRoot: root,
        branch: "deepcoder/s2",
        runGh: async (args: string[]) => {
          ghCalls.push(args);
          return "https://example/pr/1\n";
        },
      }),
    );
    assert.equal(res.committed, true);
    assert.equal(res.localOnly, false);
    assert.equal(res.prUrl, "https://example/pr/1");
    // gh was asked to CREATE a PR against the detected base, never to merge.
    assert.equal(ghCalls.length, 1);
    const args = ghCalls[0];
    assert.deepEqual([args[0], args[1]], ["pr", "create"]);
    assert.ok(args.includes("--base") && args[args.indexOf("--base") + 1] === base);
    assert.ok(args.includes("--head") && args[args.indexOf("--head") + 1] === "deepcoder/s2");
    assert.ok(!args.includes("merge"));
    // The branch exists on the bare remote (push happened).
    assert.match(git(bare, "branch", "--list", "deepcoder/s2"), /deepcoder\/s2/);
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("changes + no remote ⇒ committed locally, no PR", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" });
  try {
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "isolated change\n", "utf8");
    const res = await finalizeToBranch(ws, opts({ realRoot: root, branch: "deepcoder/s3" }));
    assert.equal(res.committed, true);
    assert.equal(res.localOnly, true);
    assert.equal(res.prUrl, undefined);
    // Branch exists locally and holds the change.
    assert.equal(git(root, "show", "deepcoder/s3:file.txt"), "isolated change\n");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("changes + remote but gh throws ⇒ falls back to local, branch still committed", async () => {
  const { root, bare } = await makeRepoWithRemote();
  const ws = await createIsolatedWorkspace(root, { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" });
  try {
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "isolated change\n", "utf8");
    const res = await finalizeToBranch(
      ws,
      opts({
        realRoot: root,
        branch: "deepcoder/s4",
        runGh: async () => {
          throw new Error("gh not installed");
        },
      }),
    );
    assert.equal(res.committed, true);
    assert.equal(res.localOnly, true);
    // The branch is never lost — it is committed locally regardless of the gh failure.
    assert.equal(git(root, "show", "deepcoder/s4:file.txt"), "isolated change\n");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});
