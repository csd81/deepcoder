/**
 * Phase 9J — the apply-gate half: applyWorker must refuse a worker whose LLM
 * quality gate is blocked, and refuse a missing gate in mandatory mode, while
 * allowing a passed gate. (qualityGate.ts logic is tested separately.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWorker } from "../../src/delegate/apply.js";
import { savePlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerTask, WorkerRun, WorkerQualityGate } from "../../src/delegate/types.js";

function git(cwd: string, ...a: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r;
}
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qa-"));
  git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A"); git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}
function planW(): { plan: DelegationPlan; w: WorkerTask } {
  const w: WorkerTask = { id: "w1", title: "t", prompt: "p", checkName: "phase", allowedPaths: ["file.txt"], forbiddenPaths: [], maxAttempts: 1, dependsOn: [], expectedOutputs: [], status: "passed" };
  return { plan: { id: "p1", task: "t", createdAt: "", status: "planned", workers: [w], dependencies: [], globalChecks: [], riskNotes: [] }, w };
}
const VALID = `--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-base\n+applied\n`;
async function writeArtifacts(root: string, qualityGate?: WorkerQualityGate): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await mkdir(dir, { recursive: true });
  const run: WorkerRun = {
    planId: "p1", workerId: "w1", sessionId: "s", worktreePath: "/tmp/x", startedAt: "", exitCode: 0,
    checkPassed: true, changedFiles: ["file.txt"], patchPath: "", patchSha256: "", summary: "", warnings: [],
    ...(qualityGate ? { qualityGate } : {}),
  };
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run), "utf8");
  await writeFile(path.join(dir, "patch.diff"), VALID, "utf8");
}
const gate = (over: Partial<WorkerQualityGate> = {}): WorkerQualityGate => ({
  enabled: true, passed: true, blocked: false, reviewerProfile: "reviewer", model: "m",
  startedAt: "", findings: [], errors: [], trace: { toolsCalled: [], turns: 1 }, ...over,
});

test("applyWorker refuses a BLOCKED quality gate; repo untouched", async () => {
  const root = await makeRepo();
  try {
    const { plan } = planW();
    await savePlan(root, plan);
    await writeArtifacts(root, gate({ passed: false, blocked: true, findings: [{ severity: "high", claim: "missing import" }] }));
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /quality gate blocked/i);
    assert.match(r.message, /missing import/);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applyWorker refuses a MISSING gate in mandatory mode", async () => {
  const root = await makeRepo();
  try {
    const { plan } = planW();
    await savePlan(root, plan);
    await writeArtifacts(root); // no qualityGate
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true, requireQualityGate: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /quality gate (is )?required but missing|quality_gate_missing/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applyWorker ALLOWS a passed quality gate", async () => {
  const root = await makeRepo();
  try {
    const { plan } = planW();
    await savePlan(root, plan);
    await writeArtifacts(root, gate({ passed: true, blocked: false }));
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true, requireQualityGate: true });
    assert.equal(r.ok, true, r.message);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "applied\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing gate is allowed when NOT mandatory (advisory)", async () => {
  const root = await makeRepo();
  try {
    const { plan } = planW();
    await savePlan(root, plan);
    await writeArtifacts(root); // no qualityGate, requireQualityGate omitted
    const r = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(r.ok, true, r.message);
  } finally { await rm(root, { recursive: true, force: true }); }
});
