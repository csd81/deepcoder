/**
 * Phase 9 — End-to-end smoke: run → auto-apply, no live model.
 *
 * Exercises the REAL pipeline — runWorker (real isolated git worktree + real
 * patch extraction) feeding autoApplyIfEligible (real validation + real
 * `git apply` to the real repo) — with ONLY the model subprocess faked. This is
 * the strongest no-live-model proof that the 9B run output and the 9F auto-apply
 * input actually compose (paths, formats, gates), which the per-unit tests don't
 * cover because they hand-write fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorker, type SpawnFn } from "../../src/delegate/workerRunner.js";
import { autoApplyIfEligible } from "../../src/delegate/autoApply.js";
import { loadPlan } from "../../src/delegate/store.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";
import type { DelegationPlan, WorkerTask } from "../../src/delegate/types.js";

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function singleWorkerPlan(): { plan: DelegationPlan; worker: WorkerTask } {
  const worker: WorkerTask = {
    id: "w1", title: "edit file", prompt: "change file.txt", checkName: "phase",
    allowedPaths: ["file.txt"], forbiddenPaths: [], maxAttempts: 1,
    dependsOn: [], expectedOutputs: [], status: "planned",
  };
  const plan: DelegationPlan = {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers: [worker], dependencies: [], globalChecks: [], riskNotes: [],
  };
  return { plan, worker };
}

/** Fake worker subprocess: edits file.txt in the worktree and "passes". */
const editingSpawn: SpawnFn = async (input) => {
  writeFileSync(path.join(input.cwd, "file.txt"), "auto-applied by worker\n");
  return { exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" };
};

test("e2e: a passing run produces a patch; auto-apply is default-off, then applies when enabled", async () => {
  const root = await makeRepo();
  try {
    const { plan, worker } = singleWorkerPlan();

    // 1. Run the worker through the REAL isolation pipeline (fake subprocess).
    const out = await runWorker({
      realRoot: root, plan, worker, signal: new AbortController().signal,
      mainEntry: "x", provider: "fake", spawnWorker: editingSpawn,
      isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch", provision: [] },
    });
    assert.equal(out.run.checkPassed, true, "worker run passed");
    assert.ok(out.patchPath && existsSync(path.join(root, out.patchPath)), "runWorker wrote patch.diff");
    // The run itself NEVER touches the real repo.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
    assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "real repo clean after run");

    // 2. Default OFF: auto-apply does nothing.
    const off = await autoApplyIfEligible(root, plan.id, worker.id, { autoApply: false });
    assert.equal(off.applied, false);
    assert.match(off.reason, /not enabled/i);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n", "still untouched");

    // 3. Enabled: the run output flows through validation + git apply into the real repo.
    const on = await autoApplyIfEligible(root, plan.id, worker.id, { autoApply: true });
    assert.equal(on.applied, true, on.reason);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "auto-applied by worker\n");

    // Plan reflects the applied status + an audit record exists.
    const saved = await loadPlan(root, plan.id);
    assert.equal(saved?.workers[0]?.status, "applied");
    assert.ok(existsSync(path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1", "apply.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("e2e: auto-apply still refuses an out-of-scope run patch end-to-end", async () => {
  const root = await makeRepo();
  try {
    const { plan, worker } = singleWorkerPlan();
    worker.allowedPaths = ["only-this.txt"]; // the worker will edit file.txt → out of scope

    const out = await runWorker({
      realRoot: root, plan, worker, signal: new AbortController().signal,
      mainEntry: "x", provider: "fake", spawnWorker: editingSpawn,
      isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch", provision: [] },
    });
    assert.equal(out.run.checkPassed, true);

    const r = await autoApplyIfEligible(root, plan.id, worker.id, { autoApply: true });
    assert.equal(r.applied, false, "out-of-scope patch must be refused at apply time");
    assert.match(r.reason, /validation/i);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n", "repo untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
