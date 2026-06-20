/**
 * Phase 9I — concurrent orchestration. Pure lock/batch helpers + the parallel
 * driver (runRunnableConcurrent) exercised with an injected runOne (no live
 * model). Proves real time-overlap, deterministic batching, deps gating,
 * conflict marking, serialized saves, abort, and NO live-repo mutation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  workerLockSet,
  locksConflict,
  buildRunnableBatches,
  runRunnableConcurrent,
  PlanSaveQueue,
} from "../../src/delegate/orchestrator.js";
import type { DelegationPlan, WorkerTask, WorkerRun } from "../../src/delegate/types.js";

function w(id: string, over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id, title: id, prompt: id, allowedPaths: [], forbiddenPaths: [], checkName: "phase",
    maxAttempts: 1, dependsOn: [], expectedOutputs: [], status: "planned", ...over,
  };
}
function plan(workers: WorkerTask[]): DelegationPlan {
  return { id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned", workers, dependencies: [], globalChecks: [], riskNotes: [] };
}
function git(cwd: string, ...a: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r;
}
async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oc-"));
  git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "f.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A"); git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}
const runRec = (id: string, over: Partial<WorkerRun> = {}): WorkerRun => ({
  planId: "p1", workerId: id, sessionId: "s", worktreePath: "/tmp/x", startedAt: "", exitCode: 0,
  checkPassed: true, changedFiles: [], patchPath: "", patchSha256: "", summary: "", warnings: [], ...over,
});
const ctx = (root: string, runOne: NonNullable<Parameters<typeof runRunnableConcurrent>[1]["runOne"]>, over = {}) => ({
  realRoot: root, signal: new AbortController().signal, mainEntry: "x", provider: "fake", runOne, ...over,
});

/* ---------------- pure helpers ---------------- */

test("workerLockSet: expectedFiles > allowedPaths; empty scope locks '.'", () => {
  assert.deepEqual(workerLockSet(w("a", { allowedPaths: ["src/a.ts"] })).paths, ["src/a.ts"]);
  assert.deepEqual(workerLockSet(w("b")).paths, ["."]); // no scope → "."
  const ef = workerLockSet(w("c", { allowedPaths: ["x"], expectedFiles: [{ path: "src/c.ts", mode: "must_change" }] }));
  assert.deepEqual(ef.paths, ["src/c.ts"], "expectedFiles wins over allowedPaths");
});

test("locksConflict: exact + prefix conflict; disjoint do not; '.' conflicts with all", () => {
  const ls = (id: string, paths: string[]) => ({ workerId: id, paths, reasonByPath: {} });
  assert.equal(locksConflict(ls("a", ["src/x.ts"]), ls("b", ["src/x.ts"])), true);  // exact
  assert.equal(locksConflict(ls("a", ["src/foo"]), ls("b", ["src/foo/bar.ts"])), true); // prefix
  assert.equal(locksConflict(ls("a", ["src/x.ts"]), ls("b", ["src/y.ts"])), false); // disjoint
  assert.equal(locksConflict(ls("a", ["."]), ls("b", ["anything"])), true); // "." wildcard
});

test("buildRunnableBatches: deps respected, maxConcurrency capped, deterministic", () => {
  const p = plan([w("a", { allowedPaths: ["a.ts"] }), w("b", { allowedPaths: ["b.ts"] }), w("c", { allowedPaths: ["c.ts"] })]);
  const b1 = buildRunnableBatches(p, { maxConcurrency: 2 });
  assert.equal(b1[0]!.workerIds.length, 2, "first batch capped at 2");
  assert.equal(b1.length, 2);
  // deterministic
  assert.deepEqual(buildRunnableBatches(p, { maxConcurrency: 2 }), b1);
  // conflicting scopes never share a batch
  const conf = buildRunnableBatches(plan([w("a", { allowedPaths: ["src"] }), w("b", { allowedPaths: ["src/x.ts"] })]), { maxConcurrency: 5 });
  assert.equal(conf.length, 2, "prefix-conflicting workers go to separate batches");
  // a dependent (dep not applied) is not in any batch
  const dep = buildRunnableBatches(plan([w("a"), w("b", { dependsOn: ["a"] })]), { maxConcurrency: 5 });
  assert.ok(!dep.flatMap((x) => x.workerIds).includes("b"), "dependent excluded until dep applied");
});

test("PlanSaveQueue serializes writes (no interleave)", async () => {
  const q = new PlanSaveQueue();
  const order: string[] = [];
  await Promise.all([
    q.enqueue(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); }),
    q.enqueue(async () => { order.push("b"); }),
  ]);
  assert.deepEqual(order, ["a", "b"], "second waits for the first despite being faster");
});

/* ---------------- concurrent driver ---------------- */

test("two independent workers run CONCURRENTLY (real time overlap)", async () => {
  const root = await repo();
  try {
    let active = 0, maxActive = 0;
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return runRec(worker.id, { checkPassed: true });
    };
    const res = await runRunnableConcurrent(plan([w("a", { allowedPaths: ["a.ts"] }), w("b", { allowedPaths: ["b.ts"] })]), ctx(root, runOne, { maxConcurrency: 2 }));
    assert.equal(maxActive, 2, "both workers were in-flight at once");
    assert.equal(res.ran.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed worker blocks its dependents but independents still run; no live mutation", async () => {
  const root = await repo();
  try {
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> =>
      runRec(worker.id, { checkPassed: worker.id !== "a" });
    const res = await runRunnableConcurrent(
      plan([w("a", { allowedPaths: ["a.ts"] }), w("b", { dependsOn: ["a"] }), w("c", { allowedPaths: ["c.ts"] })]),
      ctx(root, runOne, { maxConcurrency: 3 }),
    );
    const ranIds = res.ran.map((r) => r.workerId);
    assert.ok(ranIds.includes("a") && ranIds.includes("c"), "independent c runs");
    assert.ok(!ranIds.includes("b"), "b (depends on failed a) does not run");
    assert.ok(res.skipped.find((s) => s.workerId === "b" && /failed/.test(s.reason)));
    assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "live repo never mutated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-run changed-file overlap marks both workers conflict", async () => {
  const root = await repo();
  try {
    // disjoint LOCKS (so they batch together) but overlapping ACTUAL changed files
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> =>
      runRec(worker.id, { checkPassed: true, changedFiles: ["shared.ts"] });
    const p = plan([w("a", { allowedPaths: ["a.ts"] }), w("b", { allowedPaths: ["b.ts"] })]);
    const res = await runRunnableConcurrent(p, ctx(root, runOne, { maxConcurrency: 2 }));
    assert.ok(res.conflicts.length >= 1, "overlap detected");
    assert.equal(p.workers.find((x) => x.id === "a")!.status, "conflict");
    assert.equal(p.workers.find((x) => x.id === "b")!.status, "conflict");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trace file records batches + worker ids; nothing applied", async () => {
  const root = await repo();
  try {
    const runOne = async (_p: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> => runRec(worker.id, { checkPassed: true });
    await runRunnableConcurrent(plan([w("a", { allowedPaths: ["a.ts"] })]), ctx(root, runOne, { maxConcurrency: 2 }));
    const tracePath = path.join(root, ".deepcoder", "delegations", "p1", "orchestration.json");
    assert.ok(existsSync(tracePath), "trace persisted");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(trace.mode, "parallel");
    assert.ok(trace.batches.length >= 1 && trace.batches[0].workerIds.includes("a"));
    assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "no apply");
  } finally { await rm(root, { recursive: true, force: true }); }
});
