/**
 * Slice 3.5 — End-to-end fixes tests (A, B, C).
 *
 * Fix A: runWorker provisions .deepcoder/config.json + node_modules into worktree
 * Fix B: prepareWorkerBranch creates branch, applies patch, commits
 * Fix C: buildPlan conservative area inference (only existing paths count)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runWorker } from "../src/delegate/workerRunner.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../src/workspaceIsolation/types.js";
import type { DelegationPlan, WorkerTask } from "../src/delegate/types.js";
import type { BoundedProcessResult } from "../src/process/runBoundedProcess.js";
import { buildPlan } from "../src/delegate/planner.js";
import { prepareWorkerBranch } from "../src/delegate/openPr.js";

/* ------------------------------------------------------------------ */
/*  Git helpers                                                        */
/* ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "e2efix-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\nnode_modules/\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return root;
}

function worker(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1", title: "fix", prompt: "fix it", allowedPaths: ["file.txt"],
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

function common(root: string) {
  return {
    realRoot: root,
    mainEntry: path.join(root, "src", "cli", "main.ts"),
    provider: "deepseek",
    signal: new AbortController().signal,
    parentEnv: { PATH: process.env.PATH ?? "", DEEPCODER_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp" },
    isolationConfig: { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" as const, provision: [] },
  };
}

/* ------------------------------------------------------------------ */
/*  Fix A — Provision .deepcoder/config.json + node_modules            */
/* ------------------------------------------------------------------ */

describe("Fix A — worker worktree provisioning", () => {
  test("runWorker copies .deepcoder/config.json into the worktree at spawn time", async () => {
    const root = await makeRepo();
    try {
      // Create .deepcoder/config.json (gitignored) in the real root.
      const deepcoderDir = path.join(root, ".deepcoder");
      await mkdir(deepcoderDir, { recursive: true });
      await writeFile(path.join(deepcoderDir, "config.json"),
        JSON.stringify({ checks: { phase: { command: "true" } } }), "utf8");

      let hasConfig = false;
      const w = worker();
      await runWorker({
        ...common(root), plan: plan(w), worker: w,
        spawnWorker: async (input) => {
          hasConfig = existsSync(path.join(input.cwd, ".deepcoder", "config.json"));
          writeFileSync(path.join(input.cwd, "file.txt"), "x\n");
          return result();
        },
      });

      assert.ok(hasConfig, ".deepcoder/config.json provisioned into worktree");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runWorker ensures node_modules exists in the worktree at spawn time", async () => {
    const root = await makeRepo();
    try {
      // Create real node_modules (gitignored) so it can be symlinked.
      const nmDir = path.join(root, "node_modules");
      await mkdir(nmDir, { recursive: true });

      let hasNodeModules = false;
      const w = worker();
      await runWorker({
        ...common(root), plan: plan(w), worker: w,
        spawnWorker: async (input) => {
          hasNodeModules = existsSync(path.join(input.cwd, "node_modules"));
          writeFileSync(path.join(input.cwd, "file.txt"), "x\n");
          return result();
        },
      });

      assert.ok(hasNodeModules, "node_modules provisioned into worktree");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Fix B — prepareWorkerBranch + PR on worker branch                  */
/* ------------------------------------------------------------------ */

describe("Fix B — prepareWorkerBranch", () => {
  test("creates a new branch off base, applies patch.diff, commits, returns branch name", async () => {
    const root = await makeRepo();
    try {
      // Create a plan + worker run directory with a patch.
      const runDir = path.join(root, ".deepcoder", "delegations", "plan-1", "runs", "worker-1");
      await mkdir(runDir, { recursive: true });

      // The patch adds a new line to file.txt.
      const patch = [
        "diff --git a/file.txt b/file.txt",
        "index e440e5c..5e5c5e5 100644",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1,2 @@",
        " base",
        "+worker change",
        "", // trailing newline — git rejects a patch without one ("corrupt patch")
      ].join("\n");
      await writeFile(path.join(runDir, "patch.diff"), patch, "utf8");

      const branchName = await prepareWorkerBranch(root, "plan-1", "worker-1", {
        branch: "feat-worker-1",
        base: "HEAD",
      });

      assert.equal(branchName, "feat-worker-1");

      // Check branch exists and contains the patched change.
      const branches = git(root, "branch", "--list", "feat-worker-1").stdout.trim();
      assert.ok(branches.includes("feat-worker-1"), "branch created");

      // Check the branch's file content.
      const content = git(root, "show", "feat-worker-1:file.txt").stdout;
      assert.ok(content.includes("worker change"), "patch applied on branch");

      // Master/base is untouched.
      assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("base branch is untouched after prepareWorkerBranch", async () => {
    const root = await makeRepo();
    try {
      const runDir = path.join(root, ".deepcoder", "delegations", "plan-1", "runs", "worker-1");
      await mkdir(runDir, { recursive: true });

      const patch = [
        "diff --git a/file.txt b/file.txt",
        "index e440e5c..5e5c5e5 100644",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1,2 @@",
        " base",
        "+new line",
        "", // trailing newline — git rejects a patch without one ("corrupt patch")
      ].join("\n");
      await writeFile(path.join(runDir, "patch.diff"), patch, "utf8");

      const headBefore = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
      await prepareWorkerBranch(root, "plan-1", "worker-1", {
        branch: "feat-test",
        base: "HEAD",
      });

      // Current branch should still be the same, clean.
      const currentBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
      assert.equal(currentBranch, headBefore, "still on same branch");

      // Working tree unchanged.
      assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "base\n");
      assert.equal(git(root, "status", "--porcelain").stdout.trim(), "", "working tree clean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Fix C — Conservative area inference in planner                     */
/* ------------------------------------------------------------------ */

describe("Fix C — conservative area inference", () => {
  test("without root, a task with many terms produces exactly 1 worker", () => {
    const plan = buildPlan("add an isBlank helper to src/util/strings.ts", {
      checkNames: ["phase"],
    });
    assert.equal(plan.workers.length, 1, "without root, always 1 worker");
    const w = plan.workers[0]!;
    // allowedPaths should be ["src"] — not junk terms.
    assert.ok(!w.allowedPaths.includes("isblank"), "junk term 'isblank' not in allowedPaths");
    assert.ok(!w.allowedPaths.includes("helper"), "junk term 'helper' not in allowedPaths");
    assert.ok(!w.allowedPaths.includes("value"), "junk term 'value' not in allowedPaths");
    assert.ok(!w.allowedPaths.includes("string"), "junk term 'string' not in allowedPaths");
  });

  test("with root and one real area, produces 1 worker", async () => {
    const root = await makeRepo();
    try {
      // Create src/util/ as a real directory.
      await mkdir(path.join(root, "src", "util"), { recursive: true });

      const plan = buildPlan("add an isBlank helper to src/util/strings.ts", {
        checkNames: ["phase"],
        root,
      });
      // Only "util" maps to real src/util/ dir. "isblank", "helper", "strings" don't.
      assert.equal(plan.workers.length, 1, "one real area → 1 worker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with root and two real areas, produces 2 workers", async () => {
    const root = await makeRepo();
    try {
      // Create two real src/ dirs.
      await mkdir(path.join(root, "src", "auth"), { recursive: true });
      await mkdir(path.join(root, "src", "database"), { recursive: true });

      const plan = buildPlan("implement auth and database modules", {
        checkNames: ["phase"],
        root,
      });
      assert.equal(plan.workers.length, 2, "two real areas → 2 workers");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("vague task with no real path areas produces exactly 1 worker", () => {
    const plan = buildPlan("refactor the entire codebase for better performance", {
      checkNames: ["phase"],
    });
    assert.equal(plan.workers.length, 1, "vague task produces 1 worker");
  });
});
