/**
 * Phase 9D — Adversarial tests for multi-worker orchestration.
 *
 * Exercises the pure helpers (topoOrder / runnableWorkers / detectFileConflicts)
 * and the sequential driver (runRunnable) with an injected fake runner — no live
 * model, no real subprocess. The driver NEVER applies a patch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  topoOrder,
  runnableWorkers,
  detectFileConflicts,
  runRunnable,
} from "../../src/delegate/orchestrator.js";
import type { DelegationPlan, WorkerRun, WorkerTask } from "../../src/delegate/types.js";
import type { UiEvent } from "../../src/ui/events.js";

test("runRunnable emits worker_start/worker_done per worker via onUiEvent", async () => {
  const root = await makeRepo();
  const plan = mkPlan([w("a"), w("b")]);
  const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> =>
    mkRun(worker.id, { checkPassed: true, changedFiles: ["x.ts"] });
  const events: UiEvent[] = [];
  await runRunnable(plan, { ...ctx(root, runOne), onUiEvent: (e: UiEvent) => events.push(e) });
  await rm(root, { recursive: true, force: true });

  const starts = events.filter((e) => e.type === "worker_start");
  const dones = events.filter((e) => e.type === "worker_done");
  assert.equal(starts.length, 2, "one worker_start per worker");
  assert.equal(dones.length, 2, "one worker_done per worker");
  const ids = starts.map((e) => (e as Extract<UiEvent, { type: "worker_start" }>).id).sort();
  assert.deepEqual(ids, ["a", "b"]);
  // start precedes done for worker "a"
  const aStart = events.findIndex((e) => e.type === "worker_start" && e.id === "a");
  const aDone = events.findIndex((e) => e.type === "worker_done" && e.id === "a");
  assert.ok(aStart >= 0 && aDone > aStart, "worker_start precedes worker_done");
});

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function w(id: string, over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id, title: id, prompt: `do ${id}`, allowedPaths: [], forbiddenPaths: [],
    checkName: "phase", maxAttempts: 1, dependsOn: [], expectedOutputs: [],
    status: "planned", ...over,
  };
}

function mkPlan(workers: WorkerTask[]): DelegationPlan {
  return {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers, dependencies: [], globalChecks: [], riskNotes: [],
  };
}

function mkRun(workerId: string, over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    planId: "p1", workerId, sessionId: "s", worktreePath: "/tmp/x",
    startedAt: new Date().toISOString(), exitCode: 0, checkPassed: true,
    changedFiles: [], patchPath: "", patchSha256: "", summary: "", warnings: [], ...over,
  };
}

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "orch-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

const ctx = (root: string, runOne: NonNullable<Parameters<typeof runRunnable>[1]["runOne"]>) => ({
  realRoot: root, signal: new AbortController().signal, mainEntry: "x", provider: "fake", runOne,
});

/* ------------------------------------------------------------------ */
/*  1. topoOrder                                                       */
/* ------------------------------------------------------------------ */

test("topoOrder: dependencies come before dependents; a cycle throws", () => {
  const order = topoOrder(mkPlan([w("a"), w("b", { dependsOn: ["a"] }), w("c", { dependsOn: ["b"] })]));
  assert.ok(order.indexOf("a") < order.indexOf("b"), "a before b");
  assert.ok(order.indexOf("b") < order.indexOf("c"), "b before c");

  assert.throws(
    () => topoOrder(mkPlan([w("a", { dependsOn: ["b"] }), w("b", { dependsOn: ["a"] })])),
    /cycle/i,
  );
});

/* ------------------------------------------------------------------ */
/*  2. runnableWorkers                                                 */
/* ------------------------------------------------------------------ */

test("runnableWorkers: a dependent is runnable only once its dependency is applied", () => {
  // dep only "passed" → dependent NOT runnable
  let runnable = runnableWorkers(mkPlan([
    w("a", { status: "passed" }),
    w("b", { dependsOn: ["a"], status: "planned" }),
  ])).map((x) => x.id);
  assert.ok(!runnable.includes("b"), "passed (not applied) dependency must not unblock the dependent");

  // dep "applied" → dependent runnable
  runnable = runnableWorkers(mkPlan([
    w("a", { status: "applied" }),
    w("b", { dependsOn: ["a"], status: "planned" }),
  ])).map((x) => x.id);
  assert.ok(runnable.includes("b"), "an applied dependency unblocks the dependent");
});

/* ------------------------------------------------------------------ */
/*  3. failed-worker isolation                                         */
/* ------------------------------------------------------------------ */

test("runRunnable: a failed worker blocks its dependents while independents still run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orch-"));
  try {
    const plan = mkPlan([w("a"), w("b", { dependsOn: ["a"] }), w("c")]);
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> =>
      mkRun(worker.id, { checkPassed: worker.id !== "a" }); // a fails, b/c would pass

    const res = await runRunnable(plan, ctx(root, runOne));
    const ranIds = res.ran.map((r) => r.workerId);

    assert.ok(ranIds.includes("a"), "independent a runs");
    assert.ok(ranIds.includes("c"), "independent c still runs despite a's failure");
    assert.ok(!ranIds.includes("b"), "b (depends on failed a) never runs");
    assert.equal(res.ran.find((r) => r.workerId === "a")?.passed, false);
    assert.equal(res.ran.find((r) => r.workerId === "c")?.passed, true);

    const bSkip = res.skipped.find((s) => s.workerId === "b");
    assert.ok(bSkip && /failed worker "a"/.test(bSkip.reason), `b skipped due to a: ${bSkip?.reason}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  4. detectFileConflicts                                             */
/* ------------------------------------------------------------------ */

test("detectFileConflicts: overlapping paths report a pair; disjoint workers do not", () => {
  assert.deepEqual(
    detectFileConflicts({ a: ["x.ts", "y.ts"], b: ["y.ts", "z.ts"], c: ["w.ts"] }),
    [{ a: "a", b: "b", paths: ["y.ts"] }],
  );
  assert.deepEqual(detectFileConflicts({ a: ["x.ts"], b: ["y.ts"] }), []);
});

/* ------------------------------------------------------------------ */
/*  5. no auto-apply                                                   */
/* ------------------------------------------------------------------ */

test("runRunnable never applies: the real repo is untouched even when a worker reports changes", async () => {
  const root = await makeRepo();
  try {
    const plan = mkPlan([w("a")]);
    // The fake reports a changed file but runRunnable must NOT touch the real repo.
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> =>
      mkRun(worker.id, { checkPassed: true, changedFiles: ["file.txt"] });

    const res = await runRunnable(plan, ctx(root, runOne));
    assert.equal(res.ran.find((r) => r.workerId === "a")?.passed, true);

    // NO AUTO-APPLY: tracked tree is clean and file.txt is unchanged.
    assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "real repo must stay clean");
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
