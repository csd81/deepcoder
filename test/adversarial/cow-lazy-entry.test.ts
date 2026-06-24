import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEnsureWritableRoot } from "../../src/runtime/sessionFactory.js";
import type { Session } from "../../src/cli/repl.js";
import type { ToolContext, ToolInvocation } from "../../src/tools/types.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cow-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function worktreeCount(root: string): number {
  return git(root, "worktree", "list").trim().split("\n").filter(Boolean).length;
}

function makeSession(root: string): Session {
  return {
    config: { workspaceRoot: root, sandbox: { mode: "off", extraMounts: [] } },
    isolation: undefined,
    executionRoot: root,
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

const inv = (over: Partial<ToolInvocation>): ToolInvocation =>
  ({ kind: "read-only", describe: () => "x", execute: async () => ({ output: "" }), ...over }) as ToolInvocation;

async function cleanup(session: Session, root: string) {
  if (session.isolation) await session.isolation.cleanup().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

test("a read-only tool never provisions a worktree", async () => {
  const root = await makeRepo();
  const session = makeSession(root);
  const ctx = makeCtx(root);
  try {
    await buildEnsureWritableRoot(session, ctx)(inv({ kind: "read-only" }));
    assert.equal(session.isolation, undefined);
    assert.equal(ctx.workspaceRoot, root);
    assert.equal(worktreeCount(root), 1);
  } finally {
    await cleanup(session, root);
  }
});

test("the first write provisions exactly one worktree; a later write is a no-op", async () => {
  const root = await makeRepo();
  const session = makeSession(root);
  const ctx = makeCtx(root);
  const ensure = buildEnsureWritableRoot(session, ctx);
  try {
    await ensure(inv({ kind: "mutate" }));
    assert.ok(session.isolation, "isolation set after first write");
    const isolated = ctx.workspaceRoot;
    assert.notEqual(isolated, root, "ctx.workspaceRoot moved off the real root");
    assert.equal(worktreeCount(root), 2);

    await ensure(inv({ kind: "mutate" }));
    assert.equal(ctx.workspaceRoot, isolated, "second write does not re-provision");
    assert.equal(worktreeCount(root), 2);
  } finally {
    await cleanup(session, root);
  }
});

test("a classifier-read-only bash command does not provision; a writing one does", async () => {
  const root1 = await makeRepo();
  const s1 = makeSession(root1);
  const c1 = makeCtx(root1);
  try {
    await buildEnsureWritableRoot(s1, c1)(inv({ kind: "execute", command: "ls -la" }));
    assert.equal(s1.isolation, undefined);
    assert.equal(worktreeCount(root1), 1);
  } finally {
    await cleanup(s1, root1);
  }

  const root2 = await makeRepo();
  const s2 = makeSession(root2);
  const c2 = makeCtx(root2);
  try {
    await buildEnsureWritableRoot(s2, c2)(inv({ kind: "execute", command: "touch new" }));
    assert.ok(s2.isolation);
    assert.equal(worktreeCount(root2), 2);
  } finally {
    await cleanup(s2, root2);
  }
});

test("readTracker keys are rekeyed so a pre-switch read still satisfies read-before-write", async () => {
  const root = await makeRepo();
  const session = makeSession(root);
  const ctx = makeCtx(root);
  ctx.readTracker.add(path.join(root, "file.txt")); // read on the real root pre-switch
  try {
    await buildEnsureWritableRoot(session, ctx)(inv({ kind: "mutate" }));
    assert.ok(
      ctx.readTracker.has(path.join(ctx.workspaceRoot, "file.txt")),
      "read key follows the root switch (edit_file would otherwise reject)",
    );
    assert.ok(!ctx.readTracker.has(path.join(root, "file.txt")));
  } finally {
    await cleanup(session, root);
  }
});

test("a dirty real tree fails the write and provisions nothing", async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, "file.txt"), "uncommitted edit\n", "utf8");
  const session = makeSession(root);
  const ctx = makeCtx(root);
  try {
    await assert.rejects(() => buildEnsureWritableRoot(session, ctx)(inv({ kind: "mutate" })), /uncommitted/i);
    assert.equal(session.isolation, undefined);
    assert.equal(ctx.workspaceRoot, root);
    assert.equal(worktreeCount(root), 1);
  } finally {
    await cleanup(session, root);
  }
});

test("checkpoint capture is disabled once isolated (the worktree is the undo boundary)", async () => {
  const root = await makeRepo();
  const session = makeSession(root);
  const ctx = makeCtx(root);
  ctx.capturePreImage = async () => {};
  ctx.recordPostWrite = async () => {};
  try {
    await buildEnsureWritableRoot(session, ctx)(inv({ kind: "mutate" }));
    assert.equal(ctx.capturePreImage, undefined);
    assert.equal(ctx.recordPostWrite, undefined);
  } finally {
    await cleanup(session, root);
  }
});
