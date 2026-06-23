import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitWorktree } from "../src/workspaceIsolation/gitWorktree.js";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "deepcoder-audit-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  // a committed text file so HEAD exists
  await writeFile(path.join(root, "README.md"), "hello\n");
  // a committed binary file we'll later mutate
  await writeFile(path.join(root, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 10, 0]));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

// Fix 1: a binary edit must produce a patch that applies cleanly to the real root.
test("binary edits are captured with --binary and apply cleanly", async () => {
  const root = await makeRepo();
  try {
    const ws = await createGitWorktree(root, { includeDirty: false, provision: [] });
    // mutate the binary file inside the worktree
    await writeFile(path.join(ws.isolatedRoot, "logo.bin"), Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]));

    const diff = await ws.diff();
    assert.match(diff, /GIT binary patch/, "diff should contain a binary patch (got: " + diff.slice(0, 200) + ")");

    // must apply cleanly without forcing
    await ws.applyPatchToRealRoot({ force: false });
    const applied = Buffer.from(
      spawnSync("cat", [path.join(root, "logo.bin")], { encoding: null }).stdout,
    );
    assert.deepEqual([...applied], [9, 9, 9, 9, 9, 9, 9, 9], "binary content should be applied to real root");
    await ws.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Fix 2: a provisioned symlink (not gitignored) must NOT leak into the patch.
test("provisioned symlink dir does not leak into the diff/patch", async () => {
  const root = await makeRepo();
  // create a real node_modules dir that is NOT gitignored in this repo
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "dep.js"), "module.exports = 1;\n");
  try {
    const ws = await createGitWorktree(root, { includeDirty: true, provision: ["node_modules"] });
    assert.ok(
      ws.provisioned.some((p) => p.link.endsWith("node_modules")),
      "node_modules should have been provisioned as a symlink",
    );
    // make a normal source edit so the diff is non-empty
    await writeFile(path.join(ws.isolatedRoot, "README.md"), "hello world\n");

    const diff = await ws.diff();
    assert.doesNotMatch(diff, /node_modules/, "provisioned symlink must not appear in the diff");
    assert.doesNotMatch(diff, /120000/, "no symlink mode should leak into the patch");
    assert.match(diff, /README\.md/, "the genuine source edit should still be present");

    const changed = await ws.changedFiles();
    assert.ok(!changed.some((f) => f.includes("node_modules")), "changedFiles must exclude provisioned paths");
    assert.ok(changed.includes("README.md"), "changedFiles should include the real edit");

    // and it must apply cleanly to the real root
    await ws.applyPatchToRealRoot({ force: false });
    await ws.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
