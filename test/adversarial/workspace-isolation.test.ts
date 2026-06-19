import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createIsolatedWorkspace,
  WorkspaceIsolationError,
  isGitRepo,
  isDirty,
} from "../../src/workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION, type WorkspaceIsolationConfig } from "../../src/workspaceIsolation/types.js";
import { runCheck } from "../../src/checks/runner.js";

const cfg = (over: Partial<WorkspaceIsolationConfig> = {}): WorkspaceIsolationConfig => ({
  ...DEFAULT_WORKSPACE_ISOLATION,
  mode: "patch",
  ...over,
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** A throwaway git repo with one commit containing file.txt + .gitignore. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wsi-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), "secret.env\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

test("createIsolatedWorkspace refuses a non-git directory (v1 is git-only)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wsi-nogit-"));
  assert.equal(isGitRepo(dir), false);
  await assert.rejects(() => createIsolatedWorkspace(dir, cfg()), WorkspaceIsolationError);
  await rm(dir, { recursive: true, force: true });
});

test("a dirty repo is refused unless includeDirty is set", async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, "file.txt"), "dirty change\n", "utf8"); // uncommitted
  assert.equal(isDirty(root), true);
  try {
    await assert.rejects(() => createIsolatedWorkspace(root, cfg({ includeDirty: false })), /uncommitted/i);
    const ws = await createIsolatedWorkspace(root, cfg({ includeDirty: true }));
    assert.ok(existsSync(ws.isolatedRoot));
    await ws.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edits land only in the isolated workspace; the real repo is untouched until apply", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg());
  try {
    // Agent-style edits inside the isolated worktree.
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "isolated change\n", "utf8");
    await writeFile(path.join(ws.isolatedRoot, "added.txt"), "new file\n", "utf8");

    const changed = await ws.changedFiles();
    assert.ok(changed.includes("file.txt"));
    assert.ok(changed.includes("added.txt"));
    assert.match(await ws.diff(), /isolated change/);

    // Real repo is unchanged.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
    assert.equal(existsSync(path.join(root, "added.txt")), false);

    // Apply → real repo now matches.
    await ws.applyPatchToRealRoot({ force: false });
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "isolated change\n");
    assert.equal(await readFile(path.join(root, "added.txt"), "utf8"), "new file\n");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("an apply conflict leaves the real tree unchanged (no force)", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg());
  try {
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "isolated change\n", "utf8");
    // The live tree changed under us, conflicting with the patch base.
    await writeFile(path.join(root, "file.txt"), "live change\n", "utf8");
    await assert.rejects(() => ws.applyPatchToRealRoot({ force: false }), /apply cleanly|apply failed/i);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "live change\n");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignored/sensitive files are excluded from the generated patch", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg());
  try {
    await writeFile(path.join(ws.isolatedRoot, "secret.env"), "TOKEN=should-not-leak\n", "utf8");
    await writeFile(path.join(ws.isolatedRoot, "file.txt"), "ok\n", "utf8");
    const changed = await ws.changedFiles();
    assert.ok(!changed.includes("secret.env"), "gitignored file must not be in the patch");
    assert.doesNotMatch(await ws.diff(), /should-not-leak/);
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("checks run with the isolated root as cwd (execution plane)", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg());
  try {
    await writeFile(path.join(ws.isolatedRoot, "marker.txt"), "present\n", "utf8");
    const run = await runCheck(
      "marker",
      { command: "cat marker.txt", timeoutMs: 20_000 },
      { workspaceRoot: ws.isolatedRoot, signal: new AbortController().signal },
    );
    assert.equal(run.exitCode, 0, "check should see the file created in the isolated workspace");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup removes the temp isolated workspace", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg());
  assert.ok(existsSync(ws.isolatedRoot));
  await ws.cleanup();
  assert.equal(existsSync(ws.isolatedRoot), false);
  // The real repo survives cleanup.
  assert.ok(await stat(path.join(root, "file.txt")));
  await rm(root, { recursive: true, force: true });
});
