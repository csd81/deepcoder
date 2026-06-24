import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExec } from "../src/git/core.js";
import {
  status,
  diff,
  log,
  show,
  listBranches,
  lsFiles,
  revParse,
  revListCount,
  blame,
} from "../src/git/read.js";

async function tmpRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "gitread-"));
  await gitExec(root, ["init", "-q"]);
  await gitExec(root, ["config", "user.email", "t@t"]);
  await gitExec(root, ["config", "user.name", "t"]);
  return root;
}

/** Commit a file with `content`; returns the file's basename. */
async function commitFile(root: string, name: string, content: string, msg: string) {
  await writeFile(path.join(root, name), content);
  await gitExec(root, ["add", name]);
  await gitExec(root, ["commit", "-q", "-m", msg]);
}

test("status reports untracked then staged entries", async () => {
  const root = await tmpRepo();
  await writeFile(path.join(root, "a.txt"), "hello\n");

  let s = await status(root);
  const untracked = s.entries.find((e) => e.path === "a.txt");
  assert.ok(untracked, "a.txt should appear in status");
  assert.equal(untracked!.x, "?");
  assert.equal(untracked!.y, "?");

  await gitExec(root, ["add", "a.txt"]);
  s = await status(root);
  const staged = s.entries.find((e) => e.path === "a.txt");
  assert.ok(staged, "staged a.txt should appear in status");
  assert.equal(staged!.x, "A"); // added in index
  assert.ok(s.raw.includes("a.txt"));
});

test("status on a clean tree returns no entries", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "init");
  const s = await status(root);
  assert.deepEqual(s.entries, []);
});

test("log --oneline shows a commit", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "first commit");
  const out = await log(root, { oneline: true });
  assert.match(out, /first commit/);
  // one commit => one non-empty line
  assert.equal(out.trim().split("\n").length, 1);
});

test("log n limits commit count", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "1\n", "c1");
  await commitFile(root, "a.txt", "2\n", "c2");
  await commitFile(root, "a.txt", "3\n", "c3");
  const out = await log(root, { oneline: true, n: 2 });
  assert.equal(out.trim().split("\n").length, 2);
});

test("revParse(HEAD) returns a 40-char sha", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "init");
  const sha = await revParse(root, "HEAD");
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test("revListCount counts commits in a range", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "1\n", "c1");
  await commitFile(root, "a.txt", "2\n", "c2");
  await commitFile(root, "a.txt", "3\n", "c3");
  assert.equal(await revListCount(root, "HEAD"), 3);
});

test("listBranches contains the default branch and strips the current marker", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "init");
  const branches = await listBranches(root);
  assert.ok(branches.length >= 1, "should list at least one branch");
  // No entry retains the "* " current-branch marker.
  for (const b of branches) assert.ok(!b.startsWith("*"), `branch "${b}" kept marker`);
  const current = (await revParse(root, "HEAD")) && (await gitExec(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  assert.ok(branches.includes(current.stdout.trim()));
});

test("diff --cached shows staged changes", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "one\n", "init");
  await writeFile(path.join(root, "a.txt"), "two\n");
  await gitExec(root, ["add", "a.txt"]);

  const cached = await diff(root, { cached: true });
  assert.match(cached, /\+two/);
  assert.match(cached, /-one/);

  // Without --cached the staged change is not shown (work tree == index here).
  const unstaged = await diff(root);
  assert.equal(unstaged.trim(), "");
});

test("diff nameOnly and paths build pathspec-scoped args", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "x\n", "init");
  await commitFile(root, "b.txt", "y\n", "add b");
  await writeFile(path.join(root, "a.txt"), "x2\n");
  await writeFile(path.join(root, "b.txt"), "y2\n");
  const names = await diff(root, { nameOnly: true, paths: ["a.txt"] });
  assert.equal(names.trim(), "a.txt");
});

test("lsFiles lists tracked files", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "x\n", "init");
  await commitFile(root, "b.txt", "y\n", "add b");
  const files = await lsFiles(root);
  assert.deepEqual([...files].sort(), ["a.txt", "b.txt"]);
  const only = await lsFiles(root, ["a.txt"]);
  assert.deepEqual(only, ["a.txt"]);
});

test("show renders the HEAD commit", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "the subject line");
  const out = await show(root);
  assert.match(out, /the subject line/);
});

test("blame annotates a file", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "line one\nline two\n", "init");
  const out = await blame(root, "a.txt");
  assert.match(out, /line one/);
  const ranged = await blame(root, "a.txt", { range: "1,1" });
  assert.match(ranged, /line one/);
  assert.ok(!/line two/.test(ranged), "range should exclude line two");
});

test("value wrappers throw on a bad ref", async () => {
  const root = await tmpRepo();
  await commitFile(root, "a.txt", "hi\n", "init");
  await assert.rejects(() => revParse(root, "no-such-ref-xyz"));
});
