import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExec, isMutatingGit } from "../src/git/core.js";

async function tmpRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gitcore-"));
  await gitExec(root, ["init", "-q"]);
  await gitExec(root, ["config", "user.email", "t@t"]);
  await gitExec(root, ["config", "user.name", "t"]);
  return root;
}

test("isMutatingGit classifies read-only vs state-changing", () => {
  for (const ro of [["status"], ["diff", "--cached"], ["log", "--oneline"], ["show"], ["rev-parse", "HEAD"]]) {
    assert.equal(isMutatingGit(ro), false, ro.join(" "));
  }
  for (const mut of [["commit", "-m", "x"], ["add", "-A"], ["push"], ["merge", "b"], ["reset", "--hard"], ["checkout", "-b", "x"]]) {
    assert.equal(isMutatingGit(mut), true, mut.join(" "));
  }
  // listing forms are read-only
  assert.equal(isMutatingGit(["branch", "--list"]), false);
  assert.equal(isMutatingGit(["remote", "-v"]), false);
  assert.equal(isMutatingGit(["branch", "-D", "x"]), true);
});

test("gitExec runs a command and captures output; never throws on nonzero", async () => {
  const root = await tmpRepo();
  const status = await gitExec(root, ["status", "--porcelain"]);
  assert.equal(status.code, 0);

  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  await gitExec(root, ["add", "-A"]);
  const commit = await gitExec(root, ["commit", "-q", "-m", "init"]);
  assert.equal(commit.code, 0);

  const log = await gitExec(root, ["log", "--oneline"]);
  assert.match(log.stdout, /init/);

  // a failing git command returns nonzero, does NOT throw
  const bad = await gitExec(root, ["checkout", "nonexistent-ref"]);
  assert.notEqual(bad.code, 0);
});
