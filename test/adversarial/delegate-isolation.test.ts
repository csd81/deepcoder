/**
 * Phase 9H — delegated-worker workspace-isolation invariants.
 * The real repo must stay byte-identical after a worker run (success, failure,
 * timeout); isolation can't be turned off; the child runs in the worktree with
 * env=off; the run record carries auditable isolation metadata. No live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorker, WorkerRunError, type SpawnFn } from "../../src/delegate/workerRunner.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";
import type { DelegationPlan, WorkerTask } from "../../src/delegate/types.js";
import type { BoundedProcessResult } from "../../src/process/runBoundedProcess.js";

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}
function porcelain(root: string): string {
  return git(root, "status", "--porcelain").stdout.trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "iso-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "fix", prompt: "fix it", allowedPaths: ["file.txt", "src/generated.ts"],
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
/** Writes a NEW file in the worktree cwd, then returns the given result. */
const writingSpawn = (over: Partial<BoundedProcessResult> = {}): SpawnFn => async (input) => {
  writeFileSync(path.join(input.cwd, "file.txt"), "worker change\n");
  return result(over);
};
function common(root: string) {
  return {
    realRoot: root,
    mainEntry: path.join(root, "src", "cli", "main.ts"),
    provider: "deepseek",
    signal: new AbortController().signal,
    parentEnv: { PATH: process.env.PATH ?? "", DEEPCODER_API_KEY: "sk-x" },
    isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" as const, provision: [] },
  };
}

/* ---------------------------------------------------------------- */

test("1. runWorker refuses isolationConfig.mode='off'", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    await assert.rejects(
      runWorker({
        ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn(),
        isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "off", provision: [] },
      }),
      (e) => e instanceof WorkerRunError && /isolation off/i.test((e as Error).message),
    );
    assert.equal(porcelain(root), "", "real repo untouched after refusal");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("2+3. exit 0 with edits → patch created, but the REAL repo stays clean (no live edit)", async () => {
  const root = await makeRepo();
  try {
    assert.equal(porcelain(root), "", "clean before");
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn() });
    assert.equal(out.run.checkPassed, true);
    assert.ok(out.patchPath && existsSync(path.join(root, out.patchPath)), "patch artifact created");
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n", "live file unchanged");
    assert.equal(porcelain(root), "", "real repo clean after a passing run");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("4. nonzero exit after writing files → captured, real repo unchanged", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn({ exitCode: 1 }) });
    assert.equal(out.run.checkPassed, false);
    assert.equal(porcelain(root), "", "real repo clean after a failing run");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("5. timeout after writing files → real repo unchanged", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn({ exitCode: null, timedOut: true }) });
    assert.equal(out.run.checkPassed, false);
    assert.equal(porcelain(root), "", "real repo clean after a timed-out run");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("6. the child runs in the ISOLATED root with env DEEPCODER_WORKSPACE_ISOLATION=off (asserted together)", async () => {
  const root = await makeRepo();
  try {
    let seenCwd = "", seenEnv: string | undefined;
    const spy: SpawnFn = async (input) => {
      seenCwd = input.cwd; seenEnv = input.env.DEEPCODER_WORKSPACE_ISOLATION;
      writeFileSync(path.join(input.cwd, "file.txt"), "x\n");
      return result();
    };
    const w = worker();
    await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: spy });
    assert.notEqual(seenCwd, root, "child cwd must NOT be the real repo");
    assert.ok(seenCwd.length > 0 && seenCwd !== root, "child cwd is the isolated worktree");
    assert.equal(seenEnv, "off", "child env isolation is off because the runner already isolated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("7. the run record carries auditable isolation metadata", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn() });
    const iso = out.run.isolation;
    assert.ok(iso, "isolation record present");
    assert.equal(iso!.backend, "git-worktree");
    assert.equal(iso!.mode, "runner-owned");
    assert.equal(iso!.realRoot, root);
    assert.equal(iso!.cleaned, true, "worktree cleaned by default");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("8. keepWorktree retains the worktree and records it (not cleaned)", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    const out = await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn(), keepWorktree: true });
    const iso = out.run.isolation!;
    assert.equal(iso.kept, true);
    assert.equal(iso.cleaned, false);
    assert.ok(iso.isolatedRoot && existsSync(iso.isolatedRoot), "kept worktree still exists");
    assert.equal(porcelain(root), "", "real repo still clean even when the worktree is kept");
    // cleanup the kept worktree
    git(root, "worktree", "remove", "--force", iso.isolatedRoot!);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9. runWorker NEVER applies — the live file content is never the worker's edit", async () => {
  const root = await makeRepo();
  try {
    const w = worker();
    await runWorker({ ...common(root), plan: plan(w), worker: w, spawnWorker: writingSpawn() });
    // The worker wrote "worker change\n" in its worktree; the real repo must still read "base\n".
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
    assert.equal(porcelain(root), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
