import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEnsureWritableRoot, finalizeIsolation } from "../../src/runtime/sessionFactory.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";
import type { Session } from "../../src/cli/repl.js";
import type { ToolContext, ToolInvocation } from "../../src/tools/types.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cowf-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function makeSession(root: string, id: string): Session {
  return {
    config: {
      workspaceRoot: root,
      sandbox: { mode: "off", extraMounts: [] },
      workspaceIsolation: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "off" },
    },
    isolation: undefined,
    executionRoot: root,
    store: { id },
  } as unknown as Session;
}

function makeCtx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    readTracker: new Set<string>(),
    writeTracker: new Set<string>(),
    todos: [],
  } as ToolContext;
}

const mutate: ToolInvocation = { kind: "mutate", describe: () => "x", execute: async () => ({ output: "" }) } as ToolInvocation;

test("a full write session commits to a new branch and never touches the user's checkout", async () => {
  const root = await makeRepo();
  const session = makeSession(root, "s1");
  const ctx = makeCtx(root);
  const branchHeadBefore = git(root, "rev-parse", "HEAD").trim();
  const currentBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
  try {
    // Lazy entry, then an "agent" edit inside the worktree.
    await buildEnsureWritableRoot(session, ctx)(mutate);
    await writeFile(path.join(ctx.workspaceRoot, "file.txt"), "agent change\n", "utf8");

    await finalizeIsolation(session);

    // The user's branch HEAD and working tree are byte-identical.
    assert.equal(git(root, "rev-parse", "HEAD").trim(), branchHeadBefore, "current branch HEAD unmoved");
    assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), currentBranch, "still on the same branch");
    assert.equal(git(root, "status", "--porcelain").trim(), "", "working tree is clean");
    assert.equal(git(root, "show", `${currentBranch}:file.txt`), "base\n", "checkout content unchanged");

    // The change lives only on the deepcoder branch.
    assert.match(git(root, "branch", "--list", "deepcoder/s1"), /deepcoder\/s1/);
    assert.equal(git(root, "show", "deepcoder/s1:file.txt"), "agent change\n");

    // No legacy .patch artifact is written (the old headless behavior).
    const dc = path.join(root, ".deepcoder");
    if (existsSync(dc)) {
      const entries = await readdir(dc);
      assert.ok(!entries.some((e) => e.startsWith("isolation-") && e.endsWith(".patch")), "no isolation patch artifact");
    }
  } finally {
    if (session.isolation) await session.isolation.cleanup().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("finalize is a no-op when no worktree was ever provisioned (pure read-only session)", async () => {
  const root = await makeRepo();
  const session = makeSession(root, "s2");
  try {
    await finalizeIsolation(session); // session.isolation is undefined
    assert.equal(git(root, "branch", "--list", "deepcoder/s2").trim(), "", "no branch created");
    assert.equal(git(root, "status", "--porcelain").trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
