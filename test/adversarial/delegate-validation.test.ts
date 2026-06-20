/**
 * Phase 9K — the authoritative worker-validation pipeline (validateWorkerResult).
 * A green check alone never makes a worker applyable: completeness, patch scope,
 * quality, conflict, and run-artifact gates all participate. Pure (no model/IO
 * except an injected fileExists). Plus apply-time integration + regressions from
 * real "passed but incomplete" failures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateWorkerResult } from "../../src/delegate/validation.js";
import { applyWorker } from "../../src/delegate/apply.js";
import { savePlan } from "../../src/delegate/store.js";
import type {
  DelegationPlan, WorkerTask, WorkerRun, WorkerQualityGate, WorkerIsolationRecord,
} from "../../src/delegate/types.js";

/* ---------------- fixtures ---------------- */

function w(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "t", prompt: "p", checkName: "phase",
    allowedPaths: ["src/foo.ts"], forbiddenPaths: [], maxAttempts: 1,
    dependsOn: [], expectedOutputs: [], status: "passed", ...over,
  };
}
function planOf(worker: WorkerTask): DelegationPlan {
  return { id: "p1", task: "t", createdAt: "", status: "planned", workers: [worker], dependencies: [], globalChecks: [], riskNotes: [] };
}
const iso: WorkerIsolationRecord = { backend: "git-worktree", mode: "runner-owned", realRoot: "/r", isolatedRoot: "/tmp/wt", kept: false, cleaned: true };
function run(over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    planId: "p1", workerId: "w1", sessionId: "s", worktreePath: "/tmp/wt", startedAt: "", finishedAt: "",
    exitCode: 0, checkPassed: true, changedFiles: ["src/foo.ts"], patchPath: "", patchSha256: "", summary: "",
    warnings: [], isolation: iso, ...over,
  };
}
const PATCH = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b\n`;
const gate = (over: Partial<WorkerQualityGate> = {}): WorkerQualityGate => ({
  enabled: true, passed: true, blocked: false, reviewerProfile: "reviewer", model: "m",
  startedAt: "", findings: [], errors: [], trace: { toolsCalled: [], turns: 1 }, ...over,
});
function vinput(over: Partial<Parameters<typeof validateWorkerResult>[0]> = {}) {
  return {
    root: "/r", plan: planOf(w()), worker: w(), run: run(), patchText: PATCH,
    alreadyChangedPaths: [] as string[], qualityGateRequired: false, ...over,
  };
}
function codes(v: ReturnType<typeof validateWorkerResult>): string[] {
  return v.failures.map((f) => f.code);
}

/* ---------------- pure pipeline ---------------- */

test("all gates pass → applyable", () => {
  const v = validateWorkerResult(vinput());
  assert.equal(v.applyable, true, JSON.stringify(v.failures));
  assert.equal(v.status, "valid");
});

test("missing run → not applyable (missing_run)", () => {
  const v = validateWorkerResult(vinput({ run: null }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("missing_run"));
});

test("check failed → not applyable (check_failed)", () => {
  const v = validateWorkerResult(vinput({ run: run({ checkPassed: false }) }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("check_failed"));
});

test("empty patch → not applyable (empty_patch)", () => {
  const v = validateWorkerResult(vinput({ patchText: "" }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("empty_patch"));
});

test("out-of-scope patch → not applyable (patch_validation_failed + out_of_scope)", () => {
  const p = `--- a/outside.ts\n+++ b/outside.ts\n@@ -0,0 +1 @@\n+x\n`;
  const v = validateWorkerResult(vinput({ patchText: p, run: run({ changedFiles: ["outside.ts"] }) }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("patch_validation_failed"));
  assert.ok(v.failures.some((f) => /out_of_scope/.test(f.message)));
});

test("forbidden path → not applyable", () => {
  const wf = w({ allowedPaths: ["src/foo.ts", "secret.txt"], forbiddenPaths: ["secret.txt"] });
  const p = `--- a/secret.txt\n+++ b/secret.txt\n@@ -1 +1 @@\n-a\n+b\n`;
  const v = validateWorkerResult(vinput({ worker: wf, plan: planOf(wf), patchText: p, run: run({ changedFiles: ["secret.txt"] }) }));
  assert.equal(v.applyable, false);
  assert.ok(v.failures.some((f) => /forbidden_path/.test(f.message)));
});

test("overlap with already-changed paths → not applyable", () => {
  const v = validateWorkerResult(vinput({ alreadyChangedPaths: ["src/foo.ts"] }));
  assert.equal(v.applyable, false);
  assert.ok(v.failures.some((f) => /overlap/.test(f.message)));
});

test("completeness failure (missing required deliverable) → not applyable", () => {
  const wf = w({ deliverables: [{ id: "tests", description: "a regression test", required: true, evidence: { kind: "test_added", pathPrefix: "test/" } }] });
  // patch only touches src/foo.ts, no test/ file → completeness fails
  const v = validateWorkerResult(vinput({ worker: wf, plan: planOf(wf) }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("completeness_failed"));
});

test("quality gate blocked → not applyable (quality_gate_blocked)", () => {
  const v = validateWorkerResult(vinput({ run: run({ qualityGate: gate({ blocked: true, passed: false, findings: [{ severity: "high", claim: "bad" }] }) }) }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("quality_gate_blocked"));
  assert.equal(v.status, "blocked");
});

test("quality gate missing while mandatory → not applyable (quality_gate_missing)", () => {
  const v = validateWorkerResult(vinput({ qualityGateRequired: true }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("quality_gate_missing"));
});

test("quality gate present + passed (mandatory) → applyable", () => {
  const v = validateWorkerResult(vinput({ qualityGateRequired: true, run: run({ qualityGate: gate() }) }));
  assert.equal(v.applyable, true, JSON.stringify(v.failures));
});

test("worker status 'conflict' → not applyable (conflict)", () => {
  const wf = w({ status: "conflict" });
  const v = validateWorkerResult(vinput({ worker: wf, plan: planOf(wf), run: run() }));
  assert.equal(v.applyable, false);
  assert.ok(codes(v).includes("conflict"));
});

test("missing isolation metadata is a WARNING, not a hard failure (migration-friendly)", () => {
  const v = validateWorkerResult(vinput({ run: run({ isolation: undefined }) }));
  assert.equal(v.applyable, true, "lenient by default per the plan's migration guidance");
  assert.ok(v.warnings.some((x) => /isolation/i.test(x)));
});

/* ---------------- regressions from real failures ---------------- */

test("REGRESSION: worker passes check but misses a required deliverable → NOT applyable", () => {
  const wf = w({ expectedTests: [{ pathPrefix: "test/", description: "a test must be added" }] });
  // checkPassed true, but no test/ file changed → completeness blocks
  const v = validateWorkerResult(vinput({ worker: wf, plan: planOf(wf), run: run({ checkPassed: true }) }));
  assert.equal(v.applyable, false, "a green check alone must not be applyable");
  assert.ok(codes(v).includes("completeness_failed"));
});

test("REGRESSION: forbidden generated artifact changed while check passes → NOT applyable", () => {
  const wf = w({ allowedPaths: ["src/foo.ts", "package-lock.json"] });
  const p = `--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n`;
  const v = validateWorkerResult(vinput({ worker: wf, plan: planOf(wf), patchText: p, run: run({ checkPassed: true, changedFiles: ["package-lock.json"] }) }));
  assert.equal(v.applyable, false);
  assert.ok(v.failures.some((f) => /generated_artifact/.test(f.message)));
});

test("REGRESSION: worker timed out but left a patch → NOT applyable", () => {
  // a timed-out run reports checkPassed:false → check gate blocks
  const v = validateWorkerResult(vinput({ run: run({ checkPassed: false, exitCode: null, warnings: ["worker timed out"] }) }));
  assert.equal(v.applyable, false);
});

/* ---------------- apply-time integration ---------------- */

function git(cwd: string, ...a: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r;
}
async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "v9k-"));
  git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "foo.ts"), "a\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A"); git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "b");
  return root;
}
async function artifacts(root: string, runOver: Partial<WorkerRun> = {}, patch = PATCH): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run(runOver)), "utf8");
  await writeFile(path.join(dir, "patch.diff"), patch, "utf8");
}

test("APPLY: applyWorker refuses an invalid worker and lists failure codes", async () => {
  const root = await repo();
  try {
    await savePlan(root, planOf(w()));
    await artifacts(root, { qualityGate: gate({ blocked: true, passed: false, findings: [{ severity: "high", claim: "missing import" }] }) });
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /quality_gate_blocked/);
    assert.equal(await readFile(path.join(root, "src", "foo.ts"), "utf8"), "a\n", "repo untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("APPLY: a valid worker passes validation + git apply --check and applies", async () => {
  const root = await repo();
  try {
    await savePlan(root, planOf(w()));
    await artifacts(root);
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(r.ok, true, r.message);
    assert.equal(await readFile(path.join(root, "src", "foo.ts"), "utf8"), "b\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("APPLY: validation is RECOMPUTED at apply time (overlap appearing later refuses)", async () => {
  const root = await repo();
  try {
    await savePlan(root, planOf(w()));
    await artifacts(root);
    // Another worker already changed src/foo.ts → overlap now exists at apply time.
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true, alreadyChangedPaths: ["src/foo.ts"] });
    assert.equal(r.ok, false);
    assert.match(r.message, /overlap|patch_validation_failed/);
    assert.equal(await readFile(path.join(root, "src", "foo.ts"), "utf8"), "a\n", "not applied");
  } finally { await rm(root, { recursive: true, force: true }); }
});
