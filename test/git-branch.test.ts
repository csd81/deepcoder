import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitExec } from "../src/git/core.js";
import {
  createBranch,
  switchBranch,
  deleteBranch,
  renameBranch,
  worktreeAdd,
  worktreeRemove,
  worktreeList,
  worktreePrune,
  createTag,
  deleteTag,
} from "../src/git/branch.js";

/** mkdtemp a repo, git init/config, then create a file + initial commit. */
async function tmpRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gitbranch-"));
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.email", "t@t.test"]);
  await gitExec(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await gitExec(root, ["add", "README.md"], { mutating: true });
  const c = await gitExec(root, ["commit", "-m", "init"], { mutating: true });
  assert.equal(c.code, 0, c.stderr);
  return root;
}

async function listBranches(root: string): Promise<string> {
  const res = await gitExec(root, ["branch", "--list"]);
  return res.stdout;
}

async function head(root: string): Promise<string> {
  const res = await gitExec(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("createBranch appears in branch list; switchBranch moves HEAD", async () => {
  const root = await tmpRepo();
  await createBranch(root, "feature");
  assert.match(await listBranches(root), /feature/);
  assert.equal(await head(root), "main");

  await switchBranch(root, "feature");
  assert.equal(await head(root), "feature");

  await rm(root, { recursive: true, force: true });
});

test("createBranch with switch:true creates and checks out", async () => {
  const root = await tmpRepo();
  await createBranch(root, "topic", { switch: true });
  assert.equal(await head(root), "topic");
  assert.match(await listBranches(root), /topic/);

  await rm(root, { recursive: true, force: true });
});

test("renameBranch renames", async () => {
  const root = await tmpRepo();
  await createBranch(root, "old");
  await renameBranch(root, "old", "renamed");
  const list = await listBranches(root);
  assert.match(list, /renamed/);
  assert.doesNotMatch(list, /\bold\b/);

  await rm(root, { recursive: true, force: true });
});

test("deleteBranch removes a merged branch", async () => {
  const root = await tmpRepo();
  await createBranch(root, "gone");
  assert.match(await listBranches(root), /gone/);
  await deleteBranch(root, "gone");
  assert.doesNotMatch(await listBranches(root), /gone/);

  await rm(root, { recursive: true, force: true });
});

test("deleteBranch without force throws on unmerged branch; force:true succeeds (no -D unless asked)", async () => {
  const root = await tmpRepo();
  // Create an unmerged branch: branch off, make a commit, switch back.
  await createBranch(root, "unmerged", { switch: true });
  await writeFile(join(root, "extra.txt"), "work\n");
  await gitExec(root, ["add", "extra.txt"], { mutating: true });
  await gitExec(root, ["commit", "-m", "wip"], { mutating: true });
  await switchBranch(root, "main");

  // Safe form (-d) must refuse to drop unmerged work.
  await assert.rejects(deleteBranch(root, "unmerged"));
  assert.match(await listBranches(root), /unmerged/);

  // Force form (-D) is required and only used when explicitly requested.
  await deleteBranch(root, "unmerged", { force: true });
  assert.doesNotMatch(await listBranches(root), /unmerged/);

  await rm(root, { recursive: true, force: true });
});

test("worktreeAdd creates a linked worktree on disk and worktreeList mentions it", async () => {
  const root = await tmpRepo();
  const wtParent = await mkdtemp(join(tmpdir(), "gitbranch-wt-"));
  const wtDir = join(wtParent, "linked");

  await worktreeAdd(root, wtDir, { branch: "wt-branch" });
  assert.equal(await exists(wtDir), true);
  assert.equal(await exists(join(wtDir, ".git")), true);

  const list = await worktreeList(root);
  assert.match(list, /linked/);

  // Cleanup: remove worktree, prune, drop dirs.
  await worktreeRemove(root, wtDir, { force: true });
  await worktreePrune(root);
  assert.doesNotMatch(await worktreeList(root), /linked/);

  await rm(wtParent, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("createTag then git tag lists it; deleteTag removes it", async () => {
  const root = await tmpRepo();

  await createTag(root, "v1.0.0");
  let tags = (await gitExec(root, ["tag"])).stdout;
  assert.match(tags, /v1\.0\.0/);

  await createTag(root, "v2.0.0", { annotate: true, message: "release two" });
  tags = (await gitExec(root, ["tag"])).stdout;
  assert.match(tags, /v2\.0\.0/);

  await deleteTag(root, "v1.0.0");
  tags = (await gitExec(root, ["tag"])).stdout;
  assert.doesNotMatch(tags, /v1\.0\.0/);

  await rm(root, { recursive: true, force: true });
});
