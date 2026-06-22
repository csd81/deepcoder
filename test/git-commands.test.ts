import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/workspace/git.js";

const exec = promisify(execFile);

/** Create a real temp git repo with an initial commit of `file.txt`. */
async function initRepo(): Promise<{ root: string; git: Git }> {
  const root = await mkdtemp(path.join(tmpdir(), "git-commands-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  // Deterministic commits so revert/cherry-pick are reproducible offline.
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  await writeFile(path.join(root, "file.txt"), "v0\n");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-qm", "init"], { cwd: root });
  return { root, git: new Git(root) };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("log returns recent commits (oneline)", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await exec("git", ["commit", "-aqm", "second commit"], { cwd: root });

    const out = await git.log();
    assert.match(out, /second commit/);
    assert.match(out, /init/);
    // Defaults to 10 most recent; both commits present, init last.
    const lines = out.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);

    const limited = await git.log(1);
    const limitedLines = limited.trim().split("\n").filter(Boolean);
    assert.equal(limitedLines.length, 1);
    assert.match(limitedLines[0], /second commit/);
  } finally {
    await cleanup(root);
  }
});

test("branches marks the current branch and lists locals", async () => {
  const { root, git } = await initRepo();
  try {
    await exec("git", ["branch", "feature"], { cwd: root });
    const b = await git.branches();
    assert.equal(b.current, "main");
    assert.ok(b.local.includes("main"), `local missing main: ${JSON.stringify(b.local)}`);
    assert.ok(b.local.includes("feature"), `local missing feature: ${JSON.stringify(b.local)}`);
    assert.ok(Array.isArray(b.remote));
  } finally {
    await cleanup(root);
  }
});

test("commit stages all tracked changes and returns a hash", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    // Not yet staged; commit() should stage tracked changes.
    const result = await git.commit("update file");
    assert.match(result.hash, /^[0-9a-f]{6,}$/);
    assert.ok(result.stdout.length > 0);

    // Tree is clean afterwards.
    const status = await git.status();
    assert.ok(!/\sM\s|\?\?/.test(status), `expected clean tree, got: ${status}`);

    const log = await git.log();
    assert.match(log, /update file/);
  } finally {
    await cleanup(root);
  }
});

test("commit with explicit paths only commits those paths", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await writeFile(path.join(root, "other.txt"), "other\n");
    await exec("git", ["add", "other.txt"], { cwd: root });

    const result = await git.commit("commit file only", ["file.txt"]);
    assert.match(result.hash, /^[0-9a-f]{6,}$/);

    // other.txt remains staged (not part of this commit).
    const changed = await git.changedFiles();
    assert.ok(changed.includes("other.txt"), `other.txt should still be pending: ${JSON.stringify(changed)}`);
  } finally {
    await cleanup(root);
  }
});

test("stashSave -> stashList shows it -> stashPop restores", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "dirty\n");
    await git.stashSave("wip changes");

    // Working tree restored to committed state.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "v0\n");

    const list = await git.stashList();
    assert.match(list, /wip changes/);

    await git.stashPop();
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "dirty\n");

    // Stash is gone after pop.
    const after = await git.stashList();
    assert.ok(!/wip changes/.test(after), `stash should be empty: ${after}`);
  } finally {
    await cleanup(root);
  }
});

test("stashDrop removes a stash entry without applying it", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "dirty\n");
    await git.stashSave("throwaway");
    assert.match(await git.stashList(), /throwaway/);

    await git.stashDrop();
    const after = await git.stashList();
    assert.ok(!/throwaway/.test(after), `stash should be dropped: ${after}`);
    // Tree stays clean (drop does not apply).
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "v0\n");
  } finally {
    await cleanup(root);
  }
});

test("revert creates a new revert commit that undoes a change", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await exec("git", ["commit", "-aqm", "bump to v1"], { cwd: root });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    await git.revert(head);

    // File content reverted to v0.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "v0\n");
    // A new revert commit exists on top.
    const log = await git.log();
    assert.match(log, /Revert/i);
  } finally {
    await cleanup(root);
  }
});

test("reset --soft moves HEAD but keeps staged tree", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await exec("git", ["commit", "-aqm", "v1"], { cwd: root });

    await git.reset("HEAD~1", "soft");

    // HEAD moved back to init.
    const log = await git.log();
    assert.ok(!/v1/.test(log), `v1 commit should be gone: ${log}`);
    // Change still staged.
    const changed = await git.changedFiles();
    assert.ok(changed.includes("file.txt"));
  } finally {
    await cleanup(root);
  }
});

test("reset --hard discards the working tree change", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await exec("git", ["commit", "-aqm", "v1"], { cwd: root });

    await git.reset("HEAD~1", "hard");

    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "v0\n");
    const changed = await git.changedFiles();
    assert.deepEqual(changed, []);
  } finally {
    await cleanup(root);
  }
});

test("reset --mixed unstages but keeps file content", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "v1\n");
    await exec("git", ["commit", "-aqm", "v1"], { cwd: root });

    await git.reset("HEAD~1", "mixed");

    // Content preserved in working tree.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "v1\n");
    // But not staged (mixed default): a plain modification line.
    const status = await git.status();
    assert.match(status, /file\.txt/);
  } finally {
    await cleanup(root);
  }
});

test("amend rewrites the last commit message and returns a new hash", async () => {
  const { root, git } = await initRepo();
  try {
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const result = await git.amend("init (amended)");
    assert.match(result.hash, /^[0-9a-f]{6,}$/);

    const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    assert.notEqual(before, after);

    const log = await git.log();
    assert.match(log, /amended/);
  } finally {
    await cleanup(root);
  }
});

test("checkout switches branches", async () => {
  const { root, git } = await initRepo();
  try {
    await exec("git", ["branch", "feature"], { cwd: root });
    await git.checkout("feature");
    assert.equal((await git.branches()).current, "feature");
  } finally {
    await cleanup(root);
  }
});

test("cherryPick applies a commit from another branch", async () => {
  const { root, git } = await initRepo();
  try {
    // Make a commit on feature.
    await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
    await writeFile(path.join(root, "feat.txt"), "feature\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "add feat"], { cwd: root });
    const featCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    // Back to main, cherry-pick it.
    await exec("git", ["checkout", "-q", "main"], { cwd: root });
    await git.cherryPick(featCommit);

    assert.equal(await readFile(path.join(root, "feat.txt"), "utf8"), "feature\n");
    assert.match(await git.log(), /add feat/);
  } finally {
    await cleanup(root);
  }
});

test("merge of a fast-forwardable branch returns ok", async () => {
  const { root, git } = await initRepo();
  try {
    await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
    await writeFile(path.join(root, "feat.txt"), "feature\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "add feat"], { cwd: root });

    await exec("git", ["checkout", "-q", "main"], { cwd: root });
    const res = await git.merge("feature");
    assert.equal(res.ok, true);
    assert.equal(await readFile(path.join(root, "feat.txt"), "utf8"), "feature\n");
  } finally {
    await cleanup(root);
  }
});

test("merge with conflicting changes returns ok:false and conflict paths", async () => {
  const { root, git } = await initRepo();
  try {
    // feature edits file.txt one way.
    await exec("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
    await writeFile(path.join(root, "file.txt"), "feature-change\n");
    await exec("git", ["commit", "-aqm", "feature edit"], { cwd: root });

    // main edits the same line differently.
    await exec("git", ["checkout", "-q", "main"], { cwd: root });
    await writeFile(path.join(root, "file.txt"), "main-change\n");
    await exec("git", ["commit", "-aqm", "main edit"], { cwd: root });

    const res = await git.merge("feature");
    assert.equal(res.ok, false);
    assert.ok(res.conflicts && res.conflicts.includes("file.txt"), `expected file.txt conflict, got ${JSON.stringify(res.conflicts)}`);
  } finally {
    // Abort the in-progress merge before removing.
    await exec("git", ["merge", "--abort"], { cwd: root }).catch(() => {});
    await cleanup(root);
  }
});

test("rebase of a divergent branch onto target returns ok", async () => {
  const { root, git } = await initRepo();
  try {
    // main advances.
    await writeFile(path.join(root, "main.txt"), "main\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "main advance"], { cwd: root });

    // feature branched from init, edits a different file (no conflict).
    await exec("git", ["checkout", "-q", "-b", "feature", "HEAD~1"], { cwd: root });
    await writeFile(path.join(root, "feat.txt"), "feature\n");
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "feature work"], { cwd: root });

    const res = await git.rebase("main");
    assert.equal(res.ok, true);
    // After rebase, main.txt should be present in working tree.
    assert.equal(await readFile(path.join(root, "main.txt"), "utf8"), "main\n");
  } finally {
    await exec("git", ["rebase", "--abort"], { cwd: root }).catch(() => {});
    await cleanup(root);
  }
});

test("rebase with a conflict returns ok:false and conflict paths", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "main-change\n");
    await exec("git", ["commit", "-aqm", "main edit"], { cwd: root });

    await exec("git", ["checkout", "-q", "-b", "feature", "HEAD~1"], { cwd: root });
    await writeFile(path.join(root, "file.txt"), "feature-change\n");
    await exec("git", ["commit", "-aqm", "feature edit"], { cwd: root });

    const res = await git.rebase("main");
    assert.equal(res.ok, false);
    assert.ok(res.conflicts && res.conflicts.includes("file.txt"), `expected file.txt conflict, got ${JSON.stringify(res.conflicts)}`);
  } finally {
    await exec("git", ["rebase", "--abort"], { cwd: root }).catch(() => {});
    await cleanup(root);
  }
});

test("diffStaged shows only staged changes", async () => {
  const { root, git } = await initRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "staged\n");
    await exec("git", ["add", "file.txt"], { cwd: root });
    await writeFile(path.join(root, "other.txt"), "unstaged\n"); // untracked, not in staged diff

    const staged = await git.diffStaged();
    assert.match(staged, /staged/);
    assert.ok(!/unstaged/.test(staged), `untracked content must not appear in staged diff: ${staged}`);
  } finally {
    await cleanup(root);
  }
});

test("blame annotates lines with commit info", async () => {
  const { root, git } = await initRepo();
  try {
    const out = await git.blame("file.txt");
    // Blame annotates each line with the author and the line content.
    assert.match(out, /\(t /); // author name configured in initRepo
    assert.match(out, /v0/); // the committed line content
  } finally {
    await cleanup(root);
  }
});

test("push to a local bare-repo remote succeeds (offline)", async () => {
  const { root, git } = await initRepo();
  let bare = "";
  try {
    bare = await mkdtemp(path.join(tmpdir(), "git-bare-"));
    await exec("git", ["init", "-q", "--bare", bare], { cwd: bare });
    await exec("git", ["remote", "add", "origin", bare], { cwd: root });

    const out = await git.push("origin", "main");
    assert.ok(typeof out === "string");

    // Verify the bare repo received the branch.
    const refs = (await exec("git", ["branch", "--list"], { cwd: bare })).stdout;
    assert.match(refs, /main/);
  } finally {
    await cleanup(root);
    if (bare) await cleanup(bare);
  }
});

test("pull from a local bare-repo remote brings in remote commits (offline)", async () => {
  const bare = await mkdtemp(path.join(tmpdir(), "git-bare-"));
  const a = await mkdtemp(path.join(tmpdir(), "git-clone-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "git-clone-b-"));
  try {
    await exec("git", ["init", "-q", "--bare", bare], { cwd: bare });

    // Clone A: seed and push.
    await exec("git", ["clone", "-q", bare, a], { cwd: tmpdir() });
    await exec("git", ["config", "user.email", "t@t"], { cwd: a });
    await exec("git", ["config", "user.name", "t"], { cwd: a });
    await writeFile(path.join(a, "file.txt"), "v0\n");
    await exec("git", ["add", "-A"], { cwd: a });
    await exec("git", ["commit", "-qm", "init"], { cwd: a });
    await exec("git", ["push", "-q", "origin", "HEAD:main"], { cwd: a });

    // Clone B: pull should bring the commit.
    await exec("git", ["clone", "-q", bare, b], { cwd: tmpdir() });
    await exec("git", ["config", "user.email", "t@t"], { cwd: b });
    await exec("git", ["config", "user.name", "t"], { cwd: b });

    const gitB = new Git(b);
    await gitB.pull("origin", "main");
    assert.equal(await readFile(path.join(b, "file.txt"), "utf8"), "v0\n");
  } finally {
    await cleanup(bare);
    await cleanup(a);
    await cleanup(b);
  }
});
