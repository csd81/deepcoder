import { test } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getDelegationReviewOverview,
  getWorkerReviewDetail,
  previewApplyGates
} from "../../src/delegate/reviewBrowser.js";
import { loadWorkerArtifacts } from "../../src/delegate/artifacts.js";
import { computePatchStat } from "../../src/delegate/diffView.js";
import { renderReviewOverview, renderWorkerReview, renderPatchStat, renderGatePreview } from "../../src/delegate/reviewRender.js";
import { savePlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerRun, ApplyRecord } from "../../src/delegate/types.js";

async function setupTestEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dc-review-browser-test-"));
  
  const plan: DelegationPlan = {
    id: "p123",
    task: "Test task",
    createdAt: new Date().toISOString(),
    status: "needs_review",
    workers: [
      {
        id: "w1",
        title: "Worker 1",
        prompt: "Do something",
        allowedPaths: ["src/"],
        forbiddenPaths: [],
        checkName: "test",
        maxAttempts: 1,
        dependsOn: [],
        expectedOutputs: [],
        status: "passed"
      },
      {
        id: "w2",
        title: "Worker 2",
        prompt: "Do something else",
        allowedPaths: ["src/"],
        forbiddenPaths: [],
        checkName: "test",
        maxAttempts: 1,
        dependsOn: [],
        expectedOutputs: [],
        status: "failed"
      }
    ],
    dependencies: [],
    globalChecks: [],
    riskNotes: []
  };
  
  await savePlan(root, plan);
  
  const run1: WorkerRun = {
    planId: "p123",
    workerId: "w1",
    sessionId: "s1",
    worktreePath: "/tmp/wt",
    startedAt: new Date().toISOString(),
    exitCode: 0,
    checkPassed: true,
    changedFiles: ["src/foo.ts"],
    patchPath: "patch.diff",
    patchSha256: "abc",
    summary: "Did it",
    warnings: [],
    qualityGate: {
      enabled: true,
      passed: true,
      blocked: false,
      reviewerProfile: "reviewer",
      model: "test",
      startedAt: new Date().toISOString(),
      findings: [],
      errors: [],
      trace: { toolsCalled: [], turns: 1 }
    }
  };
  
  const runDir1 = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  await fs.mkdir(runDir1, { recursive: true });
  await fs.writeFile(path.join(runDir1, "run.json"), JSON.stringify(run1));
  await fs.writeFile(path.join(runDir1, "patch.diff"), "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+new2");
  
  const applyRecord: ApplyRecord = {
    planId: "p123",
    workerId: "w1",
    action: "applied",
    appliedAt: new Date().toISOString(),
    patchSha256: "abc"
  };
  await fs.writeFile(path.join(runDir1, "apply.json"), JSON.stringify(applyRecord));
  
  return { root, plan };
}

test("1. overview loads a valid plan with multiple worker runs", async () => {
  const { root } = await setupTestEnv();
  const overview = await getDelegationReviewOverview(root, "p123");
  assert(overview);
  assert.strictEqual(overview.planId, "p123");
  assert.strictEqual(overview.workers.length, 2);
  assert.strictEqual(overview.workers[0]!.workerId, "w1");
  assert.strictEqual(overview.workers[1]!.workerId, "w2");
});

test("2. missing run artifact yields warning, not throw", async () => {
  const { root } = await setupTestEnv();
  const artifacts = await loadWorkerArtifacts(root, "p123", "w2");
  assert.strictEqual(artifacts.run, null);
  assert(artifacts.warnings.some(w => w.includes("not found or corrupt")));
});

test("3. corrupt run.json yields warning, not throw", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  await fs.writeFile(path.join(runDir, "run.json"), "{ bad json");
  const artifacts = await loadWorkerArtifacts(root, "p123", "w1");
  assert.strictEqual(artifacts.run, null);
  assert(artifacts.warnings.some(w => w.includes("not found or corrupt")));
});

test("4. malicious plan/worker id with path traversal is REJECTED", async () => {
  const { root } = await setupTestEnv();
  const artifacts = await loadWorkerArtifacts(root, "../p123", "w1");
  assert(artifacts.warnings.some(w => w.includes("Invalid planId or workerId")));
});

test("5. patch preview is bounded AND redacted", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  const secretPatch = "diff --git a/src/foo.ts b/src/foo.ts\n+sk-1234567890abcdef\n" + "x".repeat(100000);
  await fs.writeFile(path.join(runDir, "patch.diff"), secretPatch);
  
  const artifacts = await loadWorkerArtifacts(root, "p123", "w1", { patchPreviewBytes: 1000 });
  assert(artifacts.patchPreview);
  assert(!artifacts.patchPreview.includes("sk-1234567890abcdef"));
  assert(artifacts.patchPreview.includes("sk-***"));
  assert(artifacts.patchPreview.includes("... (truncated)"));
});

test("6. diff stat counts added/removed lines and changed files", () => {
  const patch = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+new2";
  const stats = computePatchStat(patch);
  assert.strictEqual(stats.length, 1);
  assert.strictEqual(stats[0]!.path, "src/foo.ts");
  assert.strictEqual(stats[0]!.added, 2);
  assert.strictEqual(stats[0]!.removed, 1);
  assert.strictEqual(stats[0]!.kind, "modified");
});

test("7. gate preview blocks failed checks", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  const run = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
  run.checkPassed = false;
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run));
  
  const preview = await previewApplyGates(root, "p123", "w1");
  assert.strictEqual(preview.eligible, false);
  assert(preview.blockers.some(b => b.includes("Check did not pass")));
});

test("8. gate preview blocks scope violations through validatePatch", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  await fs.writeFile(path.join(runDir, "patch.diff"), "diff --git a/outside/foo.ts b/outside/foo.ts\n--- a/outside/foo.ts\n+++ b/outside/foo.ts\n+new");
  
  const preview = await previewApplyGates(root, "p123", "w1");
  assert.strictEqual(preview.eligible, false);
  assert(preview.blockers.some(b => b.includes("Patch validation failed")));
});

test("9. gate preview reports blocked quality gate", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  const run = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
  run.qualityGate.blocked = true;
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run));
  
  const preview = await previewApplyGates(root, "p123", "w1");
  assert.strictEqual(preview.eligible, false);
  assert(preview.blockers.some(b => b.includes("Quality gate blocked")));
});

test("10. gate preview can run git apply --check and surface failure", async () => {
  const { root } = await setupTestEnv();
  // git apply --check will fail because it's not a git repo
  const preview = await previewApplyGates(root, "p123", "w1", { runGitCheck: true });
  assert.strictEqual(preview.eligible, false);
  assert(preview.blockers.some(b => b.includes("git apply --check failed")));
});

test("11. rendering large plans stays under byte/line caps", async () => {
  const { root } = await setupTestEnv();
  const overview = await getDelegationReviewOverview(root, "p123");
  const rendered = renderReviewOverview(overview!, { maxLines: 1 });
  assert(rendered.includes("... (truncated lines)"));
});

test("12. /delegate diff --full never prints sensitive values unredacted", async () => {
  const { root } = await setupTestEnv();
  const runDir = path.join(root, ".deepcoder", "delegations", "p123", "runs", "w1");
  await fs.writeFile(path.join(runDir, "patch.diff"), "diff --git a/src/foo.ts b/src/foo.ts\n+sk-1234567890abcdef");
  
  const detail = await getWorkerReviewDetail(root, "p123", "w1");
  assert(!detail!.patchPreview.includes("sk-1234567890abcdef"));
  assert(detail!.patchPreview.includes("sk-***"));
});

test("13. browser never mutates the repo or plan status", async () => {
  const { root } = await setupTestEnv();
  const beforePlan = await fs.readFile(path.join(root, ".deepcoder", "delegations", "p123", "plan.json"), "utf8");
  
  await getDelegationReviewOverview(root, "p123");
  await getWorkerReviewDetail(root, "p123", "w1");
  await previewApplyGates(root, "p123", "w1");
  
  const afterPlan = await fs.readFile(path.join(root, ".deepcoder", "delegations", "p123", "plan.json"), "utf8");
  assert.strictEqual(beforePlan, afterPlan);
});

test("14. applied/discarded audit records appear in the review card", async () => {
  const { root } = await setupTestEnv();
  const detail = await getWorkerReviewDetail(root, "p123", "w1");
  const rendered = renderWorkerReview(detail!);
  assert(rendered.includes("apply.json"));
});
