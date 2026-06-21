import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/workspace/git.js";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "git-changed-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  return root;
}

test("changedFiles returns [] on a clean tree", async () => {
  const root = await initRepo();
  try {
    await writeFile(path.join(root, "a.txt"), "x\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });
    assert.deepEqual(await new Git(root).changedFiles(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changedFiles reports modified, staged, and untracked paths", async () => {
  const root = await initRepo();
  try {
    await writeFile(path.join(root, "tracked.txt"), "v0\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });

    await writeFile(path.join(root, "tracked.txt"), "v1\n"); // unstaged modification
    await writeFile(path.join(root, "staged.txt"), "new\n");
    await exec("git", ["add", "staged.txt"], { cwd: root }); // staged add
    await writeFile(path.join(root, "untracked.txt"), "u\n"); // untracked

    const files = (await new Git(root).changedFiles()).sort();
    assert.deepEqual(files, ["staged.txt", "tracked.txt", "untracked.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changedFiles parses a lone unstaged modification (leading-space porcelain line)", async () => {
  // Regression: a leading trim of the whole output would eat the " " status
  // column of the first line (" M aaa.txt") and corrupt the path.
  const root = await initRepo();
  try {
    await writeFile(path.join(root, "aaa.txt"), "v0\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });
    await writeFile(path.join(root, "aaa.txt"), "v1\n"); // unstaged modification, sorts first
    assert.deepEqual(await new Git(root).changedFiles(), ["aaa.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changedFiles reports the destination path of a rename", async () => {
  const root = await initRepo();
  try {
    await writeFile(path.join(root, "old.txt"), "content\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });

    await rename(path.join(root, "old.txt"), path.join(root, "new.txt"));
    await exec("git", ["add", "-A"], { cwd: root }); // stages the rename

    const files = await new Git(root).changedFiles();
    assert.ok(files.includes("new.txt"), `expected new.txt, got ${JSON.stringify(files)}`);
    assert.ok(!files.includes("old.txt -> new.txt"), "the raw rename arrow must be parsed away");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
