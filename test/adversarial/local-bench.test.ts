import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeQualityFlags,
  verdict,
  addedLines,
  changedPathsFromPatch,
} from "../../evals/local-bench/lib/flags.js";
import {
  loadCase,
  listCases,
  copyRepoInto,
  applyFixedOverlay,
  writeCheckConfig,
} from "../../evals/local-bench/lib/cases.js";
import { formatReport, type ResultRow } from "../../evals/local-bench/report.js";

const PATCH_ASSERT = `diff --git a/mini_flask/blueprints.py b/mini_flask/blueprints.py
--- a/mini_flask/blueprints.py
+++ b/mini_flask/blueprints.py
@@ -1,3 +1,4 @@
 class Blueprint:
     def __init__(self, name):
+        assert "." not in name, "no dots"
         self.name = name
`;

const PATCH_VALUEERROR = PATCH_ASSERT.replace(
  '+        assert "." not in name, "no dots"',
  '+        if "." in name:\n+            raise ValueError("no dots")',
);

test("addedLines / changedPathsFromPatch parse only new content + file headers", () => {
  assert.match(addedLines(PATCH_ASSERT), /assert "\." not in name/);
  assert.doesNotMatch(addedLines(PATCH_ASSERT), /class Blueprint/); // context line excluded
  assert.deepEqual(changedPathsFromPatch(PATCH_ASSERT), ["mini_flask/blueprints.py"]);
});

test("assert anti-pattern is flagged even when the test passes → NOT solved (flask lesson)", () => {
  const flags = computeQualityFlags({
    patch: PATCH_ASSERT,
    attempts: [{ patchHash: "a", patchBytes: 80 }],
    forbiddenPatterns: ["\\bassert\\b"],
    requiredPatterns: ["raise ValueError"],
    allowedPaths: ["mini_flask/blueprints.py"],
  });
  assert.ok(flags.includes("forbidden_pattern"));
  assert.ok(flags.includes("missing_required_pattern"));
  const v = verdict(/* testsPassed */ true, flags);
  assert.equal(v.tests_passed, true);
  assert.equal(v.solved, false, "a passing test with a bad patch is not solved");
});

test("a correct ValueError fix in the allowed file is clean → solved", () => {
  const flags = computeQualityFlags({
    patch: PATCH_VALUEERROR,
    attempts: [{ patchHash: "a", patchBytes: 120 }],
    forbiddenPatterns: ["\\bassert\\b"],
    requiredPatterns: ["raise ValueError"],
    allowedPaths: ["mini_flask/blueprints.py"],
  });
  assert.deepEqual(flags, []);
  assert.equal(verdict(true, flags).solved, true);
});

test("an empty patch is flagged no_code_change", () => {
  const flags = computeQualityFlags({
    patch: "",
    attempts: [{ patchHash: null, patchBytes: 0 }],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: [],
  });
  assert.deepEqual(flags, ["no_code_change"]);
  assert.equal(verdict(true, flags).solved, false, "empty patch never counts as solved");
});

test("unrelated_files and test_only flags", () => {
  const unrelated = computeQualityFlags({
    patch: "+++ b/src/other.py\n+x = 1\n",
    attempts: [],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: ["mini_flask/blueprints.py"],
  });
  assert.ok(unrelated.includes("unrelated_files"));

  const testOnly = computeQualityFlags({
    patch: "+++ b/tests/test_x.py\n+def test_new(): pass\n",
    attempts: [],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: [],
  });
  assert.ok(testOnly.includes("test_only"));
});

test("repeated identical attempt patches are detected", () => {
  const flags = computeQualityFlags({
    patch: PATCH_VALUEERROR,
    attempts: [
      { patchHash: "same", patchBytes: 50 },
      { patchHash: "same", patchBytes: 50 },
    ],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: ["mini_flask/blueprints.py"],
  });
  assert.ok(flags.includes("repeated_patch"));
});

test("repeated_patch edge cases: single attempt, distinct hashes, and excluded empty patches", () => {
  const base = { forbiddenPatterns: [], requiredPatterns: [], allowedPaths: ["solution.mjs"] };
  const flags = (attempts: { patchHash?: string | null; patchBytes?: number | null }[]) =>
    computeQualityFlags({ patch: "+++ b/solution.mjs\n+x = 1\n", attempts, ...base });

  // one attempt can't repeat
  assert.ok(!flags([{ patchHash: "a", patchBytes: 9 }]).includes("repeated_patch"));
  // two DIFFERENT non-empty patches are not a repeat
  assert.ok(!flags([{ patchHash: "a", patchBytes: 9 }, { patchHash: "b", patchBytes: 9 }]).includes("repeated_patch"));
  // empty patches (0 or null bytes) are excluded — repeated EMPTY does not count as a repeat
  assert.ok(!flags([{ patchHash: "z", patchBytes: 0 }, { patchHash: "z", patchBytes: 0 }]).includes("repeated_patch"));
  assert.ok(!flags([{ patchHash: null, patchBytes: null }, { patchHash: null, patchBytes: null }]).includes("repeated_patch"));
  // a real repeated non-empty patch alongside a null one IS flagged
  assert.ok(flags([{ patchHash: null, patchBytes: 0 }, { patchHash: "r", patchBytes: 9 }, { patchHash: "r", patchBytes: 9 }]).includes("repeated_patch"));
});

test("huge_patch measures ADDED content, not context — a small fix in a big diff is not huge", () => {
  const base = { attempts: [], forbiddenPatterns: [], requiredPatterns: [], allowedPaths: ["f.js"], hugePatchBytes: 40 };

  // Mostly context (space-prefixed) with one tiny addition → added content is tiny → NOT huge.
  const bigContext =
    "+++ b/f.js\n" + Array.from({ length: 30 }, () => " // unchanged context line").join("\n") + "\n+x = 1\n";
  assert.ok(!computeQualityFlags({ patch: bigContext, ...base }).includes("huge_patch"),
    "huge context but tiny added content must not trip huge_patch");

  // Lots of ADDED lines → over threshold → huge.
  const bigAdded =
    "+++ b/f.js\n" + Array.from({ length: 30 }, (_, i) => `+const filler${i} = ${i};`).join("\n") + "\n";
  assert.ok(computeQualityFlags({ patch: bigAdded, ...base }).includes("huge_patch"),
    "large added content must trip huge_patch");
});

test("a malformed forbidden regex never crashes (treated as no match)", () => {
  const flags = computeQualityFlags({
    patch: PATCH_VALUEERROR,
    attempts: [],
    forbiddenPatterns: ["("], // invalid regex
    requiredPatterns: [],
    allowedPaths: ["mini_flask/blueprints.py"],
  });
  assert.ok(!flags.includes("forbidden_pattern"));
});

test("loadCase parses a case, copyRepoInto does not mutate the fixture, overlay applies", async () => {
  const caseDir = await mkdtemp(path.join(tmpdir(), "lb-case-"));
  await mkdir(path.join(caseDir, "repo"), { recursive: true });
  await writeFile(path.join(caseDir, "repo", "src.py"), "buggy\n", "utf8");
  await mkdir(path.join(caseDir, "fixed"), { recursive: true });
  await writeFile(path.join(caseDir, "fixed", "src.py"), "fixed\n", "utf8");
  await writeFile(path.join(caseDir, "issue.md"), "fix it", "utf8");
  await writeFile(path.join(caseDir, "expected.md"), "raise ValueError", "utf8");
  await writeFile(
    path.join(caseDir, "check.json"),
    JSON.stringify({ name: "unit", command: "true", forbiddenPatterns: ["\\bassert\\b"] }),
    "utf8",
  );

  const m = await loadCase(caseDir);
  assert.equal(m.check.name, "unit");
  assert.equal(m.check.solveAttempts, 3, "defaulted");
  assert.deepEqual(m.check.forbiddenPatterns, ["\\bassert\\b"]);
  assert.ok(m.fixedDir);

  const ws = await mkdtemp(path.join(tmpdir(), "lb-ws-"));
  await copyRepoInto(m, ws);
  // Mutate the workspace copy; the fixture must be untouched.
  await writeFile(path.join(ws, "src.py"), "agent edited\n", "utf8");
  assert.equal(await readFile(path.join(caseDir, "repo", "src.py"), "utf8"), "buggy\n");

  // Overlay the fix, then write the check config.
  const applied = await applyFixedOverlay(m, ws);
  assert.equal(applied, true);
  assert.equal(await readFile(path.join(ws, "src.py"), "utf8"), "fixed\n");
  await writeCheckConfig(ws, m.check);
  const cfg = JSON.parse(await readFile(path.join(ws, ".deepcoder", "config.json"), "utf8"));
  assert.equal(cfg.checks.unit.command, "true");

  // listCases finds the case (parent of caseDir contains it)
  const ids = await listCases(path.dirname(caseDir));
  assert.ok(ids.includes(path.basename(caseDir)));
});

test("report distinguishes solved from passed-but-flagged and counts skips", () => {
  const rows: ResultRow[] = [
    { id: "a", tests_passed: true, quality_passed: true, solved: true, quality_flags: [], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["x"] },
    { id: "b", tests_passed: true, quality_passed: false, solved: false, quality_flags: ["forbidden_pattern"], attempts: 2, patch_bytes: 20, timed_out: false, changed_files: ["y"] },
    { id: "c", skipped: true, tests_passed: false, quality_passed: false, solved: false, quality_flags: [], attempts: 0, patch_bytes: 0, timed_out: false, changed_files: [] },
  ];
  const out = formatReport(rows);
  assert.match(out, /solved \(tests\+quality\): 1\/2/);
  assert.match(out, /tests passed:\s+2\/2/);
  assert.match(out, /passed but FLAGGED:\s+1\/2/); // the green-but-bad patch
  assert.match(out, /\+1 skipped/);
});

test("a case missing its command is rejected (malformed → runner can skip)", async () => {
  const caseDir = await mkdtemp(path.join(tmpdir(), "lb-bad-"));
  await mkdir(path.join(caseDir, "repo"), { recursive: true });
  await writeFile(path.join(caseDir, "issue.md"), "x", "utf8");
  await writeFile(path.join(caseDir, "check.json"), JSON.stringify({ name: "unit" }), "utf8");
  await assert.rejects(() => loadCase(caseDir), /non-empty "command"/);
});
