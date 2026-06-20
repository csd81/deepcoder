import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorker, type SpawnFn } from "../../src/delegate/workerRunner.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";
import type { DelegationPlan, WorkerTask } from "../../src/delegate/types.js";
import type { BoundedProcessResult } from "../../src/process/runBoundedProcess.js";

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wr-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  // Mirror production: .deepcoder/ (control-plane artifacts) is gitignored, so
  // writing plan/run records there never dirties the tree.
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "fix", prompt: "fix it", allowedPaths: ["file.txt"],
    forbiddenPaths: [], checkName: "phase", maxAttempts: 1, dependsOn: [],
    expectedOutputs: [], status: "planned", ...over,
  };
}
function plan(w: WorkerTask): DelegationPlan {
  return {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers: [w], dependencies: [], globalChecks: [], riskNotes: [],
  };
}

const result = (over: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "", ...over,
});

/** A fake worker that edits the worktree and exits 0. */
const editingSpawn: SpawnFn = async (input) => {
  writeFileSync(path.join(input.cwd, "file.txt"), "worker change\n");
  return result();
};

function common(root: string) {
  return {
    realRoot: root,
    mainEntry: path.join(root, "src", "cli", "main.ts"),
    provider: "deepseek",
    signal: new AbortController().signal,
    parentEnv: { PATH: process.env.PATH ?? "", DEEPCODER_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp" },
    isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" as const, provision: [] },
  };
}

test("a worker that edits the worktree and exits 0 yields a patch + passed, real root untouched", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: editingSpawn });
    assert.equal(out.run.checkPassed, true);
    assert.ok(out.changedFiles.includes("file.txt"));
    assert.ok(out.patchPath && existsSync(path.join(root, out.patchPath)), "patch artifact written");
    // NO AUTO-APPLY: the real repo file is unchanged.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
    assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "real root clean");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-zero worker exit is recorded as not-passed, never thrown", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({
      ...common(root), plan: plan(w), worker: w,
      spawnWorker: async (i) => { writeFileSync(path.join(i.cwd, "file.txt"), "x\n"); return result({ exitCode: 1 }); },
    });
    assert.equal(out.run.checkPassed, false);
    assert.equal(out.run.exitCode, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty patch (worker made no edits) is not passed and is flagged", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({
      ...common(root), plan: plan(w), worker: w,
      spawnWorker: async () => result(), // exit 0 but no edits
    });
    assert.equal(out.run.checkPassed, false, "exit 0 with no patch is not a pass");
    assert.ok(out.run.warnings.some((x) => /empty|no chang/i.test(x)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out worker is not passed and is flagged", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({
      ...common(root), plan: plan(w), worker: w,
      spawnWorker: async () => result({ exitCode: null, timedOut: true }),
    });
    assert.equal(out.run.checkPassed, false);
    assert.ok(out.run.warnings.some((x) => /tim(e|ed) ?out/i.test(x)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested delegation is refused (delegateDepth > 0)", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    await assert.rejects(
      runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: editingSpawn, delegateDepth: 1 }),
      /nest|deleg/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dirty tree is refused", async () => {
  const root = await makeRepo();
  try {
    await writeFile(path.join(root, "file.txt"), "dirty\n", "utf8"); // uncommitted
    const w = worker();
    await assert.rejects(
      runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: editingSpawn }),
      /uncommitted|dirty/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree is cleaned up by default and retained with keepWorktree", async () => {
  const root = await makeRepo();
  try {
    let w = worker();
    const a = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: editingSpawn });
    assert.ok(!existsSync(a.run.worktreePath), "default cleans the worktree");

    w = worker();
    const b = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: editingSpawn, keepWorktree: true });
    assert.ok(existsSync(b.run.worktreePath), "keepWorktree retains the worktree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the spawn receives allowlisted env, the worktree cwd, and shell-free argv", async () => {
  const root = await makeRepo();
  try {
    let seen: Parameters<SpawnFn>[0] | undefined;
    const w = worker({ prompt: "do; rm -rf / the thing" });
    await runWorker({
      ...common(root), plan: plan(w), worker: w,
      spawnWorker: async (i) => { seen = i; writeFileSync(path.join(i.cwd, "file.txt"), "x\n"); return result(); },
    });
    assert.ok(seen, "spawn was invoked");
    assert.equal(seen!.cwd.includes(root) || seen!.cwd !== root, true);
    assert.notEqual(seen!.cwd, root, "child runs in the worktree, not the real root");
    assert.equal(seen!.file, process.execPath);
    assert.equal(seen!.args[seen!.args.length - 1], "do; rm -rf / the thing");
    assert.ok(!seen!.shell, "no shell");
    assert.equal(seen!.env.DEEPCODER_DELEGATE_DEPTH, "1");
    assert.equal(seen!.env.DEEPCODER_API_KEY, "sk-secret", "key forwarded via env");
    assert.equal(seen!.env.GITHUB_TOKEN, undefined, "GITHUB_TOKEN must not leak");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
