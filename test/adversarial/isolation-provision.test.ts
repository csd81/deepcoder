import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIsolatedWorkspace, provisionWorktree } from "../../src/workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION, type WorkspaceIsolationConfig } from "../../src/workspaceIsolation/types.js";
import { runCheck } from "../../src/checks/runner.js";

const cfg = (over: Partial<WorkspaceIsolationConfig> = {}): WorkspaceIsolationConfig => ({
  ...DEFAULT_WORKSPACE_ISOLATION,
  mode: "patch",
  ...over,
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A git repo with a committed file and a gitignored deps/ dir (untracked). */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prov-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "app.mjs"), "export const v = 1;\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), "deps/\n", "utf8");
  await mkdir(path.join(root, "deps"), { recursive: true });
  await writeFile(path.join(root, "deps", "marker.mjs"), "export const dep = 42;\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

test("provisionWorktree symlinks a dep dir; the worktree resolves it; cleanup keeps the real target", async () => {
  const root = await makeRepo();
  const ws = await createIsolatedWorkspace(root, cfg({ provision: ["deps"] }));
  try {
    // The worktree (a checkout of HEAD) would NOT have the gitignored deps/ — provisioning adds it.
    assert.ok(ws.provisioned.some((p) => path.basename(p.link) === "deps"), "deps should be provisioned");
    assert.equal(
      await readFile(path.join(ws.isolatedRoot, "deps", "marker.mjs"), "utf8"),
      "export const dep = 42;\n",
      "the dep file must be reachable through the symlink",
    );
  } finally {
    await ws.cleanup();
    // cleanup removed the worktree but must NOT delete the real deps/.
    assert.ok(await stat(path.join(root, "deps", "marker.mjs")), "the real dep target survives cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionWorktree never shadows a tracked path and rejects non-allowlist names", async () => {
  const root = await makeRepo();
  // A real worktree checkout: tracked files (app.mjs) are present; gitignored deps/ is absent.
  const ws = await createIsolatedWorkspace(root, cfg({ provision: [] }));
  try {
    const links = await provisionWorktree(root, ws.isolatedRoot, ["app.mjs", "../escape", "a/b", "deps"]);
    const names = links.map((l) => path.basename(l.link));
    assert.ok(names.includes("deps"), "the gitignored dep dir is provisioned");
    assert.ok(!names.includes("app.mjs"), "must not shadow a tracked file already in the worktree");
    assert.ok(!names.some((n) => n.includes("escape") || n === "b"), "separators/.. are rejected");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a check that imports a provisioned dep runs green in the worktree (no manual symlink)", async () => {
  const root = await makeRepo();
  // A tracked test that imports the gitignored dep — only runnable if deps/ is provisioned.
  await writeFile(
    path.join(root, "check.mjs"),
    "import { dep } from './deps/marker.mjs'; if (dep !== 42) process.exit(1); console.log('ok');\n",
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "add check");
  const ws = await createIsolatedWorkspace(root, cfg({ provision: ["deps"] }));
  try {
    const run = await runCheck(
      "dep",
      { command: "node check.mjs", timeoutMs: 20_000 },
      { workspaceRoot: ws.isolatedRoot, signal: new AbortController().signal },
    );
    assert.equal(run.exitCode, 0, "the check should resolve the provisioned dep and pass");
  } finally {
    await ws.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
