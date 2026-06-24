import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitExec } from "../src/git/core.js";
import { merge, stash } from "../src/git/integrate.js";

/** Create a temp git repo with an initial commit on the default branch. */
async function tmpRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gitintegrate-"));
  await gitExec(root, ["init", "-q"]);
  await gitExec(root, ["config", "user.email", "test@example.com"]);
  await gitExec(root, ["config", "user.name", "Test"]);
  await gitExec(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await gitExec(root, ["add", "file.txt"]);
  await gitExec(root, ["commit", "-q", "-m", "initial"]);
  // Pin a deterministic branch name regardless of git's init.defaultBranch.
  await gitExec(root, ["branch", "-M", "main"]);
  return root;
}

async function commitFile(root: string, content: string, msg: string): Promise<void> {
  await writeFile(join(root, "file.txt"), content);
  await gitExec(root, ["add", "file.txt"]);
  await gitExec(root, ["commit", "-q", "-m", msg]);
}

/** Make two branches diverge on the same line so they later conflict. */
async function diverge(root: string): Promise<void> {
  await gitExec(root, ["checkout", "-q", "-b", "feature"]);
  await commitFile(root, "feature change\n", "feature");
  await gitExec(root, ["checkout", "-q", "main"]);
  await commitFile(root, "main change\n", "main");
}

test("merge with noFf creates a merge commit", async () => {
  const root = await tmpRepo();
  try {
    // Non-conflicting divergence: change different files.
    await gitExec(root, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(root, "other.txt"), "from feature\n");
    await gitExec(root, ["add", "other.txt"]);
    await gitExec(root, ["commit", "-q", "-m", "feature work"]);
    await gitExec(root, ["checkout", "-q", "main"]);
    await commitFile(root, "main moved on\n", "main work");

    const res = await merge(root, "feature", { noFf: true });
    assert.equal(res.code, 0, `merge failed: ${res.stderr}`);

    const merges = await gitExec(root, ["log", "--merges", "--oneline"]);
    assert.notEqual(merges.stdout.trim(), "", "expected a merge commit in log --merges");

    // The HEAD commit should have two parents.
    const parents = await gitExec(root, ["rev-list", "--parents", "-n", "1", "HEAD"]);
    const count = parents.stdout.trim().split(/\s+/).length - 1; // minus the commit itself
    assert.equal(count, 2, `expected 2 parents, got ${count}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting merge returns nonzero; abort restores a clean tree", async () => {
  const root = await tmpRepo();
  try {
    await diverge(root);

    const res = await merge(root, "feature");
    assert.notEqual(res.code, 0, "expected conflicting merge to return nonzero");

    // Tree is dirty mid-conflict.
    const dirty = await gitExec(root, ["status", "--porcelain"]);
    assert.notEqual(dirty.stdout.trim(), "", "expected dirty tree during conflict");

    const aborted = await merge(root, "ignored", { abort: true });
    assert.equal(aborted.code, 0, `abort failed: ${aborted.stderr}`);

    const clean = await gitExec(root, ["status", "--porcelain"]);
    assert.equal(clean.stdout.trim(), "", "expected clean tree after abort");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stash push then pop round-trips an uncommitted change", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(join(root, "file.txt"), "uncommitted edit\n");

    const before = await gitExec(root, ["status", "--porcelain"]);
    assert.notEqual(before.stdout.trim(), "", "expected a dirty tree to stash");

    const pushed = await stash(root, { push: true });
    assert.equal(pushed.code, 0, `stash push failed: ${pushed.stderr}`);

    const stashed = await gitExec(root, ["status", "--porcelain"]);
    assert.equal(stashed.stdout.trim(), "", "expected clean tree after stash push");

    const popped = await stash(root, { pop: true });
    assert.equal(popped.code, 0, `stash pop failed: ${popped.stderr}`);

    const restored = await gitExec(root, ["status", "--porcelain"]);
    assert.notEqual(restored.stdout.trim(), "", "expected the change back after pop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
