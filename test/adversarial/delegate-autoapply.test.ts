/**
 * Phase 9F — Adversarial tests for gated auto-apply.
 *
 * Auto-apply is the only path that mutates the real repo WITHOUT interactive
 * confirmation, so these tests pin its safety: default OFF, fail-closed on every
 * precondition, and the real repo byte-identical whenever it refuses.
 * Real git repo + real patch/run fixtures; no live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoApplyIfEligible } from "../../src/delegate/autoApply.js";
import { savePlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerTask, WorkerRun } from "../../src/delegate/types.js";

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "autoapply-repo-"));
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
    id: "w1", title: "fix", prompt: "fix it", checkName: "phase",
    allowedPaths: ["file.txt"], forbiddenPaths: [], maxAttempts: 1,
    dependsOn: [], expectedOutputs: [], status: "passed", ...over,
  };
}

function plan(workers: WorkerTask[] = [worker()]): DelegationPlan {
  return {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers, dependencies: [], globalChecks: [], riskNotes: [],
  };
}

async function writeRun(root: string, over: Partial<WorkerRun> = {}): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await mkdir(dir, { recursive: true });
  const run: WorkerRun = {
    planId: "p1", workerId: "w1", sessionId: "s", worktreePath: "/tmp/x",
    startedAt: new Date().toISOString(), exitCode: 0, checkPassed: true,
    changedFiles: ["file.txt"], patchPath: "", patchSha256: "", summary: "", warnings: [], ...over,
  };
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2), "utf8");
}

async function writePatch(root: string, content: string): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "patch.diff"), content, "utf8");
}

const VALID_PATCH = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-base
+applied
`;
const SENSITIVE_PATCH = `--- a/.env
+++ b/.env
@@ -0,0 +1 @@
+SECRET=x
`;
const GENERATED_PATCH = `--- a/node_modules/x.js
+++ b/node_modules/x.js
@@ -0,0 +1 @@
+evil
`;

/** Assert the real repo is byte-identical to its committed state. */
async function assertUntouched(root: string): Promise<void> {
  assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "real repo must be clean");
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
}

/* ------------------------------------------------------------------ */

test("1. DEFAULT off: autoApply:false never applies, even when everything else is valid", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan());
    await writeRun(root);
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: false });
    assert.equal(r.applied, false);
    assert.match(r.reason, /not enabled/i);
    await assertUntouched(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2. happy path: enabled + single worker + check passed + small in-scope patch → applies", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan());
    await writeRun(root);
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: true });
    assert.equal(r.applied, true, r.reason);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "applied\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("3. multi-worker plan is refused (auto-apply requires a single-worker plan)", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan([worker(), worker({ id: "w2" })]));
    await writeRun(root);
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: true });
    assert.equal(r.applied, false);
    assert.match(r.reason, /single-worker/i);
    await assertUntouched(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("4. a worker whose check did not pass is refused", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan());
    await writeRun(root, { checkPassed: false });
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: true });
    assert.equal(r.applied, false);
    assert.match(r.reason, /check did not pass/i);
    await assertUntouched(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("5. a patch larger than maxPatchBytes is refused", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan());
    await writeRun(root);
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: true, maxPatchBytes: 10 });
    assert.equal(r.applied, false);
    assert.match(r.reason, /too large/i);
    await assertUntouched(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6. a patch touching a sensitive or generated path is refused", async () => {
  for (const patch of [SENSITIVE_PATCH, GENERATED_PATCH]) {
    const root = await makeRepo();
    try {
      await savePlan(root, plan());
      await writeRun(root);
      await writePatch(root, patch);

      const r = await autoApplyIfEligible(root, "p1", "w1", { autoApply: true });
      assert.equal(r.applied, false, `should refuse: ${patch.slice(0, 20)}`);
      assert.match(r.reason, /validation/i);
      await assertUntouched(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("7. a patch overlapping already-applied paths is refused (conflict)", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, plan());
    await writeRun(root);
    await writePatch(root, VALID_PATCH);

    const r = await autoApplyIfEligible(root, "p1", "w1", {
      autoApply: true, alreadyChangedPaths: ["file.txt"],
    });
    assert.equal(r.applied, false);
    assert.match(r.reason, /validation|overlap/i);
    await assertUntouched(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
