import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitExec, isMutatingGit } from "../src/git/core.js";
import { add, restore, commit, reset } from "../src/git/commit.js";

/** Fresh temp repo with a configured identity; returns its root. */
async function tmpRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gitcommit-"));
  await gitExec(root, ["init", "-q"]);
  await gitExec(root, ["config", "user.email", "test@example.com"]);
  await gitExec(root, ["config", "user.name", "Test User"]);
  await gitExec(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

async function logSubjects(root: string): Promise<string[]> {
  const res = await gitExec(root, ["log", "--format=%s"]);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function head(root: string): Promise<string> {
  return (await gitExec(root, ["rev-parse", "HEAD"])).stdout.trim();
}

test("add + commit creates a commit with the message", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "hello\n");
    await add(root, { all: true });
    const { hash } = await commit(root, { message: "first commit" });
    assert.ok(hash && /^[0-9a-f]+$/.test(hash), `expected a short hash, got ${hash}`);
    assert.deepEqual(await logSubjects(root), ["first commit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit returns a hash; amend + noEdit rewrites HEAD", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "v1\n");
    await add(root, { paths: ["a.txt"] });
    const first = await commit(root, { message: "orig" });
    const headBefore = await head(root);

    // Stage another change and amend without changing the message.
    await writeFile(path.join(root, "a.txt"), "v2\n");
    await add(root, { paths: ["a.txt"] });
    const amended = await commit(root, { amend: true, noEdit: true });

    const headAfter = await head(root);
    assert.notEqual(headBefore, headAfter, "amend should rewrite HEAD");
    assert.ok(amended.hash, "amend returns a hash");
    assert.notEqual(first.hash, amended.hash, "rewritten hash differs");
    // Still a single commit, message preserved by --no-edit.
    assert.deepEqual(await logSubjects(root), ["orig"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset --soft moves HEAD back but keeps the index staged", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "one\n");
    await add(root, { all: true });
    await commit(root, { message: "c1" });

    await writeFile(path.join(root, "b.txt"), "two\n");
    await add(root, { all: true });
    await commit(root, { message: "c2" });

    assert.deepEqual(await logSubjects(root), ["c2", "c1"]);

    await reset(root, { soft: true, ref: "HEAD~1" });

    // HEAD moved back to c1...
    assert.deepEqual(await logSubjects(root), ["c1"]);
    // ...but b.txt is still staged (soft keeps the index).
    const staged = await gitExec(root, ["diff", "--cached", "--name-only"]);
    assert.deepEqual(
      staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
      ["b.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore --staged unstages a file", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "seed\n");
    await add(root, { all: true });
    await commit(root, { message: "seed" });

    await writeFile(path.join(root, "a.txt"), "changed\n");
    await add(root, { paths: ["a.txt"] });

    let staged = await gitExec(root, ["diff", "--cached", "--name-only"]);
    assert.deepEqual(
      staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
      ["a.txt"],
    );

    await restore(root, { staged: true, paths: ["a.txt"] });

    staged = await gitExec(root, ["diff", "--cached", "--name-only"]);
    assert.deepEqual(
      staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
      [],
      "file should be unstaged after restore --staged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset path-form unstages without moving HEAD", async () => {
  const root = await tmpRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "seed\n");
    await add(root, { all: true });
    await commit(root, { message: "seed" });
    const before = await head(root);

    await writeFile(path.join(root, "a.txt"), "changed\n");
    await add(root, { paths: ["a.txt"] });
    await reset(root, { paths: ["a.txt"] });

    assert.equal(await head(root), before, "path reset must not move HEAD");
    const staged = await gitExec(root, ["diff", "--cached", "--name-only"]);
    assert.deepEqual(staged.stdout.trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit failures throw (nothing staged)", async () => {
  const root = await tmpRepo();
  try {
    await assert.rejects(() => commit(root, { message: "empty" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safety classification: commit and add are mutating", () => {
  assert.equal(isMutatingGit(["commit", "-m", "x"]), true);
  assert.equal(isMutatingGit(["add", "-A"]), true);
  assert.equal(isMutatingGit(["restore", "--staged", "--", "a.txt"]), true);
  assert.equal(isMutatingGit(["reset", "--soft", "HEAD~1"]), true);
});
