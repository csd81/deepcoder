/**
 * Phase 9L — TDD delegated workers. SEED (red-first) tests pinning the core
 * contract; the worker implements the modules to make these green and then adds
 * the remaining lifecycle/apply tests from the plan. No live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReproPhasePrompt, buildFixPhasePrompt } from "../../src/delegate/tddPrompts.js";
import { writeTddRecord, readTddRecord } from "../../src/delegate/tddArtifacts.js";
import type { WorkerTask, DelegationPlan, WorkerTddRun } from "../../src/delegate/types.js";

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "fix parser", prompt: "fix the parser bug", checkName: "phase",
    allowedPaths: ["src/parser.ts", "test/parser.test.ts"], forbiddenPaths: [], maxAttempts: 1,
    dependsOn: [], expectedOutputs: [], status: "planned",
    tdd: { required: true, allowedTestPaths: ["test/"] }, ...over,
  };
}
const plan: DelegationPlan = {
  id: "p1", task: "t", createdAt: "", status: "planned", workers: [worker()],
  dependencies: [], globalChecks: [], riskNotes: [],
};

test("buildReproPhasePrompt: test-only, forbids production edits, isolated", () => {
  const p = buildReproPhasePrompt(worker(), plan);
  assert.equal(typeof p, "string");
  assert.ok(p.length > 0);
  assert.match(p, /test/i);
  assert.match(p, /not|forbid|only/i, "must constrain to tests-only / forbid production edits");
});

test("buildFixPhasePrompt: notes the repro is confirmed-failing and must not be weakened", () => {
  const p = buildFixPhasePrompt(worker(), plan, "baseline failed as expected (exit 1)");
  assert.equal(typeof p, "string");
  assert.match(p, /repro|test/i);
  assert.match(p, /not (delete|weaken|remove)|preserve|keep/i, "must forbid weakening/deleting the repro");
});

test("tddArtifacts: writeTddRecord → readTddRecord round-trips the TDD run record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tdd-"));
  try {
    const rec: WorkerTddRun = {
      required: true, status: "green_confirmed", reproPaths: ["test/parser.test.ts"],
      redRunId: "chk_red", greenRunId: "chk_green", warnings: [],
    };
    await writeTddRecord(root, "p1", "w1", rec);
    const loaded = await readTddRecord(root, "p1", "w1");
    assert.deepEqual(loaded, rec);
    // missing record → null (never throws)
    assert.equal(await readTddRecord(root, "p1", "nope"), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* ---- 9L.2+ red seed: forces tdd.ts (runWorkerTdd) + apply.ts TDD gate ---- */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { runWorkerTdd } from "../../src/delegate/tdd.js";
import { applyWorker } from "../../src/delegate/apply.js";
import { savePlan } from "../../src/delegate/store.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";
import type { WorkerRun } from "../../src/delegate/types.js";

function gitT(cwd: string, ...a: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r;
}
async function tddRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tddrepo-"));
  gitT(root, "init", "-q"); gitT(root, "config", "user.email", "t@t"); gitT(root, "config", "user.name", "t");
  await writeFile(path.join(root, "src.ts"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  gitT(root, "add", "-A"); gitT(root, "-c", "commit.gpgsign=false", "commit", "-qm", "b");
  return root;
}

test("9L.2 seed: runWorkerTdd passes a NON-TDD worker through unchanged (returns a WorkerRun)", async () => {
  const root = await tddRepo();
  try {
    const w = worker({ tdd: undefined, allowedPaths: ["src.ts"] });
    const plan2: DelegationPlan = { id: "p1", task: "t", createdAt: "", status: "planned", workers: [w], dependencies: [], globalChecks: [], riskNotes: [] };
    const out = await runWorkerTdd({
      realRoot: root, plan: plan2, worker: w, signal: new AbortController().signal,
      mainEntry: "x", provider: "fake",
      isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch", provision: [] },
      spawnWorker: async (i) => { writeFileSync(path.join(i.cwd, "src.ts"), "x\n"); return { exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" }; },
    });
    assert.ok(out && typeof out === "object", "returns a WorkerRun");
    assert.equal(gitT(root, "status", "--porcelain").stdout.trim(), "", "real repo untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9L.4 seed: applyWorker refuses a TDD-required worker without green_confirmed", async () => {
  const root = await tddRepo();
  try {
    const w = worker({ allowedPaths: ["src.ts"], status: "passed", tdd: { required: true, allowedTestPaths: ["test/"] } });
    const plan2: DelegationPlan = { id: "p1", task: "t", createdAt: "", status: "planned", workers: [w], dependencies: [], globalChecks: [], riskNotes: [] };
    await savePlan(root, plan2);
    const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
    await mkdir(dir, { recursive: true });
    const run: WorkerRun = { planId: "p1", workerId: "w1", sessionId: "s", worktreePath: "/tmp", startedAt: "", exitCode: 0, checkPassed: true, changedFiles: ["src.ts"], patchPath: "", patchSha256: "", summary: "", warnings: [] /* no tdd green */ };
    await writeFile(path.join(dir, "run.json"), JSON.stringify(run), "utf8");
    await writeFile(path.join(dir, "patch.diff"), "--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-base\n+fixed\n", "utf8");
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(r.ok, false, "TDD-required worker without green proof must not apply");
    assert.match(r.message, /tdd|green/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* ---- 9L.5: orchestration red→green verification (drives real runWorkerTdd) ---- */

import { mkdirSync } from "node:fs";

async function tddFixtureRepo(baseline = "BUG"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tddfix-"));
  gitT(root, "init", "-q"); gitT(root, "config", "user.email", "t@t"); gitT(root, "config", "user.name", "t");
  await writeFile(path.join(root, "value.txt"), baseline + "\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  gitT(root, "add", "-A"); gitT(root, "-c", "commit.gpgsign=false", "commit", "-qm", "b");
  return root;
}
function tddWorker(over: Partial<WorkerTask> = {}): WorkerTask {
  return worker({
    checkName: "tddchk", allowedPaths: ["value.txt", "test/repro.test.ts"],
    tdd: { required: true, allowedTestPaths: ["test/"] }, status: "planned", ...over,
  });
}
function tddPlan(w: WorkerTask): DelegationPlan {
  return { id: "p1", task: "t", createdAt: "", status: "planned", workers: [w], dependencies: [], globalChecks: [], riskNotes: [] };
}
/** A 2-phase fake: call 1 writes a repro test; call 2 writes the production fix value. */
function phasedSpawn(fixValue: string | null) {
  let n = 0;
  return async (i: { cwd: string }) => {
    n++;
    if (n === 1) { mkdirSync(path.join(i.cwd, "test"), { recursive: true }); writeFileSync(path.join(i.cwd, "test", "repro.test.ts"), "// repro asserts value FIXED\n"); }
    else if (fixValue !== null) { writeFileSync(path.join(i.cwd, "value.txt"), fixValue + "\n"); }
    return { exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" };
  };
}
function tddOpts(root: string, spawn: ReturnType<typeof phasedSpawn>, checkCmd: string) {
  return {
    realRoot: root, plan: tddPlan(tddWorker()), worker: tddWorker(), signal: new AbortController().signal,
    mainEntry: "x", provider: "fake",
    isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" as const, provision: [] },
    checks: { tddchk: { command: checkCmd } },
    spawnWorker: spawn as unknown as SpawnFn,
  };
}

test("9L.5: repro fails on baseline (red_confirmed) → fix → green_confirmed", async () => {
  const root = await tddFixtureRepo("BUG");
  try {
    const out = await runWorkerTdd(tddOpts(root, phasedSpawn("FIXED"), "grep -q FIXED value.txt"));
    assert.equal(out.run.tdd?.status, "green_confirmed", JSON.stringify(out.run.tdd));
    assert.equal(gitT(root, "status", "--porcelain").stdout.trim(), "", "real repo untouched (no apply)");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9L.5: a repro that PASSES on baseline cannot self-grade → red_failed (no fix)", async () => {
  const root = await tddFixtureRepo("BUG");
  try {
    // check passes on baseline (grep BUG) → repro does not fail → red_failed
    const out = await runWorkerTdd(tddOpts(root, phasedSpawn("FIXED"), "grep -q BUG value.txt"));
    assert.equal(out.run.tdd?.status, "red_failed", JSON.stringify(out.run.tdd));
    assert.notEqual(out.run.checkPassed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9L.5: green check still failing after fix → green_failed (not passed)", async () => {
  const root = await tddFixtureRepo("BUG");
  try {
    // red confirms (FIXED absent), but the fix writes the WRONG value → green fails
    const out = await runWorkerTdd(tddOpts(root, phasedSpawn("STILL_BUGGED"), "grep -q FIXED value.txt"));
    assert.equal(out.run.tdd?.status, "green_failed", JSON.stringify(out.run.tdd));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9L.5: repro phase touching a PRODUCTION file is blocked (not test-only)", async () => {
  const root = await tddFixtureRepo("BUG");
  try {
    // repro-phase fake writes value.txt (production) instead of a test → blocked
    const badRepro = async (i: { cwd: string }) => { writeFileSync(path.join(i.cwd, "value.txt"), "X\n"); return { exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" }; };
    const out = await runWorkerTdd(tddOpts(root, badRepro as unknown as ReturnType<typeof phasedSpawn>, "grep -q FIXED value.txt"));
    assert.notEqual(out.run.tdd?.status, "green_confirmed");
    assert.equal(gitT(root, "status", "--porcelain").stdout.trim(), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9L.5: an empty repro patch is blocked when TDD is required", async () => {
  const root = await tddFixtureRepo("BUG");
  try {
    const noRepro = async () => ({ exitCode: 0, signal: null, timedOut: false, truncated: false, captured: "" });
    const out = await runWorkerTdd(tddOpts(root, noRepro as unknown as ReturnType<typeof phasedSpawn>, "grep -q FIXED value.txt"));
    assert.notEqual(out.run.tdd?.status, "green_confirmed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
