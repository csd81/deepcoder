/**
 * Phase 9N — verify-then-force. Proves a FINISHED one-pass patch is complete +
 * non-self-grading by splitting it (tests-only → red on baseline; full → green),
 * without forcing a tests-first loop. No live model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isTestPath,
  extractPatchForPaths,
  evaluateVerify,
  verifyManifestCoverage,
} from "../../src/delegate/verify.js";
import type { CoverageProbeResult } from "../../src/delegate/tdd.js";
import type { WorkerDeliverableSpec } from "../../src/delegate/coverage.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../../src/workspaceIsolation/types.js";

const D: WorkerDeliverableSpec[] = [
  { id: "d1", acceptance: "a" },
  { id: "d2", acceptance: "b" },
];

/* ---- pure: path + patch splitting ---- */

test("isTestPath: recognizes test/ and tests/ prefixes only", () => {
  assert.equal(isTestPath("test/x.test.ts"), true);
  assert.equal(isTestPath("tests/y.test.ts"), true);
  assert.equal(isTestPath("src/checks/planner.ts"), false);
});

test("extractPatchForPaths: keeps only the matching file sections", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-base",
    "+fixed",
    "diff --git a/test/x.test.ts b/test/x.test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/test/x.test.ts",
    "@@ -0,0 +1 @@",
    "+test('[d1] x', () => {})",
  ].join("\n");
  const tests = extractPatchForPaths(patch, (p) => isTestPath(p));
  assert.match(tests, /test\/x\.test\.ts/);
  assert.doesNotMatch(tests, /src\/a\.ts/, "production section must be excluded");
  assert.equal(extractPatchForPaths(patch, () => false), "");
});

/* ---- pure: verdict ---- */

test("evaluateVerify: red-on-baseline + green + in-scope → ok", () => {
  const v = evaluateVerify(D, "not ok 1 - [d1]\nnot ok 2 - [d2]", "ok 1 - [d1]\nok 2 - [d2]", true, true);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("evaluateVerify: a test that PASSES on baseline (vacuous) → not ok", () => {
  // d2 passes with tests-only applied (no production change) → self-grading.
  const v = evaluateVerify(D, "not ok 1 - [d1]\nok 2 - [d2]", "ok 1 - [d1]\nok 2 - [d2]", true, true);
  assert.equal(v.ok, false);
  assert.equal(v.redComplete, false);
  assert.match(v.reasons.join(" "), /vacuous|without the production/i);
});

test("evaluateVerify: a deliverable with no tagged test → not ok", () => {
  const v = evaluateVerify(D, "not ok 1 - [d1]", "ok 1 - [d1]", true, true);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(" "), /no tagged test/i);
});

test("evaluateVerify: out-of-scope patch → not ok even when red+green pass", () => {
  const v = evaluateVerify(D, "not ok 1 - [d1]\nnot ok 2 - [d2]", "ok 1 - [d1]\nok 2 - [d2]", true, false);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(" "), /outside the allowed/i);
});

test("evaluateVerify: full patch not green → not ok", () => {
  const v = evaluateVerify(D, "not ok 1 - [d1]\nnot ok 2 - [d2]", "ok 1 - [d1]\nnot ok 2 - [d2]", false, true);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(" "), /not green/i);
});

/* ---- orchestration: real git patch + injected probe ---- */

function git(cwd: string, ...a: string[]): SpawnSyncReturns<string> {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r;
}

/** A baseline repo + a real `git diff` patch that adds a test and edits src. */
async function repoAndPatch(): Promise<{ root: string; patch: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "verify-"));
  git(root, "init", "-q"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const v = 0;\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".deepcoder/\n", "utf8");
  git(root, "add", "-A"); git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  // Make the changes, then capture them as a patch and reset.
  await writeFile(path.join(root, "src", "a.ts"), "export const v = 1;\n", "utf8");
  await writeFile(path.join(root, "test", "x.test.ts"), "// [d1] and [d2] regression\n", "utf8");
  git(root, "add", "-N", "test/x.test.ts");
  const patch = git(root, "diff").stdout;
  git(root, "reset", "-q", "--hard", "HEAD"); git(root, "clean", "-fdq");
  return { root, patch };
}

function probe2(redTap: string, redExit: number, greenTap: string, greenExit: number) {
  let n = 0;
  return async (): Promise<CoverageProbeResult> => {
    n++;
    return n === 1
      ? { tap: redTap, exitCode: redExit, refused: false, runId: "red" }
      : { tap: greenTap, exitCode: greenExit, refused: false, runId: "green" };
  };
}

const iso = { ...DEFAULT_WORKSPACE_ISOLATION, mode: "patch" as const };

test("9N verify: a complete, in-scope, red→green patch verifies OK (no forcing)", async () => {
  const { root, patch } = await repoAndPatch();
  try {
    const v = await verifyManifestCoverage({
      realRoot: root, fullPatch: patch, deliverables: D,
      testCommand: "node --test test/x.test.ts", allowedPaths: ["src/", "test/"],
      signal: new AbortController().signal, isolationConfig: iso,
      runCoverageProbe: probe2("not ok 1 - [d1]\nnot ok 2 - [d2]", 1, "ok 1 - [d1]\nok 2 - [d2]", 0),
    });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.redComplete, true);
    assert.equal(v.greenComplete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9N verify: an out-of-scope file is rejected (scope gate)", async () => {
  const { root, patch } = await repoAndPatch();
  try {
    const v = await verifyManifestCoverage({
      realRoot: root, fullPatch: patch, deliverables: D,
      testCommand: "node --test test/x.test.ts", allowedPaths: ["test/"], // src/a.ts now out of scope
      signal: new AbortController().signal, isolationConfig: iso,
      runCoverageProbe: probe2("not ok 1 - [d1]\nnot ok 2 - [d2]", 1, "ok 1 - [d1]\nok 2 - [d2]", 0),
    });
    assert.equal(v.scopeOk, false);
    assert.equal(v.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("9N verify: a test green on baseline-without-impl (vacuous) is rejected", async () => {
  const { root, patch } = await repoAndPatch();
  try {
    const v = await verifyManifestCoverage({
      realRoot: root, fullPatch: patch, deliverables: D,
      testCommand: "node --test test/x.test.ts", allowedPaths: ["src/", "test/"],
      signal: new AbortController().signal, isolationConfig: iso,
      // d2 passes with tests-only on baseline → vacuous, self-grading.
      runCoverageProbe: probe2("not ok 1 - [d1]\nok 2 - [d2]", 1, "ok 1 - [d1]\nok 2 - [d2]", 0),
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.coverage?.nonRed, ["d2"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});