import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExec } from "../src/git/core.js";
import {
  buildPushArgs,
  buildCleanArgs,
  fetch,
  push,
  listRemotes,
  getRemoteUrl,
  clean,
} from "../src/git/remote.js";

async function tmpRepo(prefix = "gitremote-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await gitExec(root, ["init", "-q"]);
  await gitExec(root, ["config", "user.email", "t@t"]);
  await gitExec(root, ["config", "user.name", "t"]);
  return root;
}

async function bareRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gitremote-bare-"));
  const res = await gitExec(dir, ["init", "--bare", "-q"]);
  assert.equal(res.code, 0);
  return dir;
}

// (a) Pure arg-construction — no network.

test("buildPushArgs never includes --force unless force:true", () => {
  assert.equal(buildPushArgs().includes("--force"), false);
  assert.equal(buildPushArgs({ remote: "origin", branch: "main" }).includes("--force"), false);
  assert.equal(buildPushArgs({ force: false }).includes("--force"), false);
  assert.equal(buildPushArgs({ force: true }).includes("--force"), true);
});

test("buildPushArgs maps typed options to flags", () => {
  const args = buildPushArgs({ remote: "origin", branch: "main", setUpstream: true });
  assert.deepEqual(args, ["push", "--set-upstream", "origin", "main"]);
  assert.equal(buildPushArgs({ delete: true, remote: "origin", branch: "old" }).includes("--delete"), true);
});

test("buildCleanArgs defaults to dry-run -n; only -f when force:true", () => {
  assert.equal(buildCleanArgs().includes("-n"), true);
  assert.equal(buildCleanArgs().includes("-f"), false);
  assert.equal(buildCleanArgs({ dryRun: true }).includes("-n"), true);
  assert.equal(buildCleanArgs({ force: false }).includes("-n"), true);
  const forced = buildCleanArgs({ force: true });
  assert.equal(forced.includes("-f"), true);
  assert.equal(forced.includes("-n"), false);
  assert.equal(buildCleanArgs({ force: true, directories: true }).includes("-d"), true);
});

// (b) Local end-to-end against a bare repo as the remote — no network.

test("push(setUpstream) to a local bare remote succeeds, then fetch works", async () => {
  const bare = await bareRepo();
  const work = await tmpRepo();

  await writeFile(path.join(work, "a.txt"), "hello", "utf8");
  await gitExec(work, ["add", "-A"]);
  const commit = await gitExec(work, ["commit", "-q", "-m", "init"]);
  assert.equal(commit.code, 0);

  // Name the branch deterministically (init default varies across git versions).
  await gitExec(work, ["branch", "-M", "main"]);

  const add = await gitExec(work, ["remote", "add", "origin", bare]);
  assert.equal(add.code, 0);

  // Read-only listing wrappers see the remote.
  const remotes = await listRemotes(work);
  assert.match(remotes, /origin/);
  assert.equal(await getRemoteUrl(work, "origin"), bare);

  const pushed = await push(work, { remote: "origin", branch: "main", setUpstream: true });
  assert.equal(pushed.code, 0, pushed.stderr);

  // The bare remote now holds the commit.
  const refs = await gitExec(bare, ["rev-parse", "main"]);
  assert.equal(refs.code, 0);

  const fetched = await fetch(work, { remote: "origin" });
  assert.equal(fetched.code, 0, fetched.stderr);
});

test("clean defaults to a dry run and deletes nothing", async () => {
  const work = await tmpRepo();
  await writeFile(path.join(work, "tracked.txt"), "x", "utf8");
  await gitExec(work, ["add", "-A"]);
  await gitExec(work, ["commit", "-q", "-m", "init"]);

  // An untracked file present.
  await writeFile(path.join(work, "junk.txt"), "junk", "utf8");

  const dry = await clean(work);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /junk\.txt/); // reported as "Would remove"

  // Still present after dry run.
  const status = await gitExec(work, ["status", "--porcelain"]);
  assert.match(status.stdout, /junk\.txt/);

  // Forced clean removes it.
  const forced = await clean(work, { force: true });
  assert.equal(forced.code, 0);
  const after = await gitExec(work, ["status", "--porcelain"]);
  assert.doesNotMatch(after.stdout, /junk\.txt/);
});
