/**
 * Phase 9C — Adversarial tests for the apply/discard logic.
 *
 * These tests exercise the full gate chain of applyWorker / discardWorker
 * using a real git repo and a real patch file. apply is called with `isTTY`
 * and `confirmResult` overrides so it never blocks on stdin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWorker, discardWorker } from "../../src/delegate/apply.js";
import { savePlan, loadPlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerTask, WorkerRun, ApplyRecord } from "../../src/delegate/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "apply-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

/** Create a minimal plan with one worker. */
function planWithWorker(over: Partial<WorkerTask> = {}): DelegationPlan {
  return {
    id: "p1",
    task: "test task",
    createdAt: new Date().toISOString(),
    status: "planned",
    workers: [
      {
        id: "w1",
        title: "fix",
        prompt: "fix it",
        checkName: "phase",
        allowedPaths: ["file.txt"],
        forbiddenPaths: [],
        maxAttempts: 1,
        dependsOn: [],
        expectedOutputs: [],
        status: "passed",
        ...over,
      },
    ],
    dependencies: [],
    globalChecks: [],
    riskNotes: [],
  };
}

/** Write a run.json for a worker. */
async function writeRun(root: string, planId: string, workerId: string, over: Partial<WorkerRun> = {}): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
  await mkdir(dir, { recursive: true });
  const run: WorkerRun = {
    planId,
    workerId,
    sessionId: "s1",
    worktreePath: "/tmp/fake",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    checkPassed: true,
    changedFiles: ["file.txt"],
    patchPath: "",
    patchSha256: "abc",
    summary: "passed",
    warnings: [],
    ...over,
  };
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2), "utf8");
}

/** Write a patch.diff for a worker. */
async function writePatch(root: string, planId: string, workerId: string, content: string): Promise<void> {
  const dir = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "patch.diff"), content, "utf8");
}

/** A valid patch that edits file.txt. */
const VALID_PATCH = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-base
+applied
`;

/** A patch that edits a forbidden path (other.txt). */
const FORBIDDEN_PATCH = `--- a/other.txt
+++ b/other.txt
@@ -1 +1 @@
-other
+evil
`;

/** A patch that edits a path outside allowed scope. */
const OUT_OF_SCOPE_PATCH = `--- a/outside.txt
+++ b/outside.txt
@@ -0,0 +1 @@
+new file
`;

/** A patch whose context does not match the real file (won't git apply --check). */
const CONFLICT_PATCH = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-this-is-not-the-real-base-content
+changed
`;

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

test("1. happy path: apply a valid patch to the real repo", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.record?.action, "applied");
    assert.equal(result.record?.patchSha256.length, 64);

    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "applied\n");

    const saved = await loadPlan(root, "p1");
    assert.equal(saved?.workers[0]?.status, "applied");

    const applyPath = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1", "apply.json");
    assert.ok(existsSync(applyPath), "apply.json must exist");
    const record = JSON.parse(await readFile(applyPath, "utf8")) as ApplyRecord;
    assert.equal(record.action, "applied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2. refuse apply when the worker check did not pass", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1", { checkPassed: false });
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("check did not pass"));
    // The real repo must be untouched.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("3. refuse apply when the worker status is not 'passed'", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker({ status: "failed" }));
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('"failed"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("4. refuse apply when the patch is out of scope", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", OUT_OF_SCOPE_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("out_of_scope"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("5. refuse apply when the patch touches a forbidden path", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker({ forbiddenPaths: ["other.txt"] }));
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", FORBIDDEN_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("forbidden_path"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6. refuse apply when the patch overlaps with already-changed paths", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", {
      isTTY: true, confirmResult: true, alreadyChangedPaths: ["file.txt"],
    });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("overlap"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("7. refuse apply when git apply --check does not apply cleanly (repo moved)", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", CONFLICT_PATCH); // in-scope but stale context

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("git apply --check failed"), result.message);
    // Nothing applied.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("8. refuse apply in non-TTY session, real repo untouched", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: false, confirmResult: true });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("Non-interactive"));
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("9. refuse apply when the user cancels confirm", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", { isTTY: true, confirmResult: false });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("cancelled"));
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10. a post-apply global-check failure is reported, but the change and audit record are preserved", async () => {
  const root = await makeRepo();
  try {
    const plan = planWithWorker();
    plan.globalChecks = ["phase"];
    await savePlan(root, plan);
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", {
      isTTY: true,
      confirmResult: true,
      checks: { phase: { command: `node -e "process.exit(1)"` } },
    });

    // Apply SUCCEEDS (we do not revert on a failing post-apply check)…
    assert.equal(result.ok, true, result.message);
    // …the change is on disk…
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "applied\n");
    // …the failing global check is reported…
    const phase = result.globalCheckResults?.find((g) => g.name === "phase");
    assert.ok(phase && phase.passed === false, "failing global check must be reported");
    assert.ok(/global check/i.test(result.message), "message warns about the failed check");
    // …and the audit trail is preserved with the check result.
    const applyPath = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1", "apply.json");
    const record = JSON.parse(await readFile(applyPath, "utf8")) as ApplyRecord;
    assert.equal(record.action, "applied");
    assert.ok(record.globalCheckResults?.some((g) => g.name === "phase" && !g.passed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("11. a passing post-apply global check is recorded as passed", async () => {
  const root = await makeRepo();
  try {
    const plan = planWithWorker();
    plan.globalChecks = ["phase"];
    await savePlan(root, plan);
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await applyWorker(root, "p1", "w1", {
      isTTY: true,
      confirmResult: true,
      checks: { phase: { command: `node -e "process.exit(0)"` } },
    });
    assert.equal(result.ok, true, result.message);
    const phase = result.globalCheckResults?.find((g) => g.name === "phase");
    assert.ok(phase && phase.passed === true, "passing global check must be recorded as passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("12. discardWorker marks the worker discarded, writes an audit record, never touches the repo", async () => {
  const root = await makeRepo();
  try {
    await savePlan(root, planWithWorker());
    await writeRun(root, "p1", "w1");
    await writePatch(root, "p1", "w1", VALID_PATCH);

    const result = await discardWorker(root, "p1", "w1");
    assert.equal(result.ok, true);
    assert.equal(result.record?.action, "discarded");

    const saved = await loadPlan(root, "p1");
    assert.equal(saved?.workers[0]?.status, "discarded");

    const applyPath = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1", "apply.json");
    assert.ok(existsSync(applyPath), "apply.json must exist");
    const record = JSON.parse(await readFile(applyPath, "utf8")) as ApplyRecord;
    assert.equal(record.action, "discarded");
    assert.equal(record.patchSha256, "");

    // The real repo must be untouched.
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
