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
  applyOracleOverlay,
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
  assert.match(out, /quality-blocked:\s+1\/2/); // the green-but-bad patch
  assert.match(out, /\+1 skipped/);
});

test("a case missing its command is rejected (malformed → runner can skip)", async () => {
  const caseDir = await mkdtemp(path.join(tmpdir(), "lb-bad-"));
  await mkdir(path.join(caseDir, "repo"), { recursive: true });
  await writeFile(path.join(caseDir, "issue.md"), "x", "utf8");
  await writeFile(path.join(caseDir, "check.json"), JSON.stringify({ name: "unit" }), "utf8");
  await assert.rejects(() => loadCase(caseDir), /non-empty "command"/);
});

// ── Phase 6C: hard-case harness fields + flags ──────────────────────────────

const HARD_BASE = {
  patch: "+++ b/src/lib.js\n+const x = 1;\n",
  attempts: [],
  forbiddenPatterns: [],
  requiredPatterns: [],
  allowedPaths: [] as string[],
};

test("missing_expected_change: an expected path not touched is flagged; touching it is clean", () => {
  const missed = computeQualityFlags({ ...HARD_BASE, expectedChangedPaths: ["src/helper.js"] });
  assert.ok(missed.includes("missing_expected_change"), "expected path src/helper.js was not touched");

  const hit = computeQualityFlags({ ...HARD_BASE, expectedChangedPaths: ["src/lib.js"] });
  assert.ok(!hit.includes("missing_expected_change"), "the expected path was touched");
});

test("forbidden_path_changed: editing a forbidden path is flagged (caller-only / test hack)", () => {
  const flags = computeQualityFlags({
    patch: "+++ b/tests/test_public.py\n+def test_x(): pass\n",
    attempts: [],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: [],
    forbiddenChangedPaths: ["tests/test_public.py"],
  });
  assert.ok(flags.includes("forbidden_path_changed"));
});

test("requiredTestPaths accepts a directory prefix: any test under tests/ counts (6D retune)", () => {
  const base = { forbiddenPatterns: [], requiredPatterns: [], allowedPaths: ["blueprints.py", "tests/"] };
  // The exact live behavior from 6C: fix blueprints.py + add a test in the
  // EXISTING tests/test_basic.py. Under the ["tests/"] prefix this is clean.
  const inExisting = computeQualityFlags({
    patch: "+++ b/blueprints.py\n+raise ValueError('x')\n+++ b/tests/test_basic.py\n+def test_dot(): pass\n",
    attempts: [],
    requiredTestPaths: ["tests/"],
    ...base,
  });
  assert.ok(!inExisting.includes("missing_required_test"), "a test under tests/ satisfies the prefix");
  assert.ok(!inExisting.includes("unrelated_files"), "tests/ is an allowed prefix");

  // No test anywhere under tests/ → still flagged.
  const noTest = computeQualityFlags({
    patch: "+++ b/blueprints.py\n+raise ValueError('x')\n",
    attempts: [],
    requiredTestPaths: ["tests/"],
    ...base,
  });
  assert.ok(noTest.includes("missing_required_test"));
});

test("missing_required_test: no listed test added is flagged; adding one is clean", () => {
  const codeOnly = computeQualityFlags({
    patch: "+++ b/blueprints.py\n+raise ValueError('x')\n",
    attempts: [],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: [],
    requiredTestPaths: ["tests/test_regression.py"],
  });
  assert.ok(codeOnly.includes("missing_required_test"), "agent added code but no required test");

  const withTest = computeQualityFlags({
    patch: "+++ b/blueprints.py\n+raise ValueError('x')\n+++ b/tests/test_regression.py\n+def test_r(): pass\n",
    attempts: [],
    forbiddenPatterns: [],
    requiredPatterns: [],
    allowedPaths: [],
    requiredTestPaths: ["tests/test_regression.py"],
  });
  assert.ok(!withTest.includes("missing_required_test"), "the required test was added");
});

test("repro_invalid: the runner-computed flag passes straight through to the verdict", () => {
  const invalid = computeQualityFlags({ ...HARD_BASE, reproInvalid: true });
  assert.ok(invalid.includes("repro_invalid"));
  assert.equal(verdict(true, invalid).solved, false, "a green test with an invalid repro is not solved");

  const valid = computeQualityFlags({ ...HARD_BASE, reproInvalid: false });
  assert.ok(!valid.includes("repro_invalid"));
});

test("repo-scale path-count + group constraints (Phase 6E)", () => {
  const base = { attempts: [], forbiddenPatterns: [], requiredPatterns: [], allowedPaths: [] as string[] };
  const patch = (paths: string[]) =>
    paths.map((p) => `+++ b/${p}\n+x\n`).join("");

  // too_few_changed_paths: minChangedPaths 2
  assert.ok(computeQualityFlags({ patch: patch(["src/a.py"]), minChangedPaths: 2, ...base }).includes("too_few_changed_paths"));
  assert.ok(!computeQualityFlags({ patch: patch(["src/a.py", "tests/t.py"]), minChangedPaths: 2, ...base }).includes("too_few_changed_paths"));

  // too_many_changed_paths: maxChangedPaths 2
  assert.ok(computeQualityFlags({ patch: patch(["a", "b", "c"]), maxChangedPaths: 2, ...base }).includes("too_many_changed_paths"));
  assert.ok(!computeQualityFlags({ patch: patch(["a", "b"]), maxChangedPaths: 2, ...base }).includes("too_many_changed_paths"));

  // missing_required_path_group: each group needs ≥1 changed path
  const groups = [["src/auth/", "src/http/"], ["tests/"]];
  // touched a source-area file but no test → second group unmet
  assert.ok(computeQualityFlags({ patch: patch(["src/http/session.py"]), requiredChangedPathGroups: groups, ...base }).includes("missing_required_path_group"));
  // touched both groups → clean
  assert.ok(!computeQualityFlags({ patch: patch(["src/http/session.py", "tests/test_x.py"]), requiredChangedPathGroups: groups, ...base }).includes("missing_required_path_group"));
});

test("applyOracleOverlay restores the graded test even if the workspace overwrote it", async () => {
  const caseDir = await mkdtemp(path.join(tmpdir(), "lb-oracle-case-"));
  await mkdir(path.join(caseDir, "repo"), { recursive: true });
  await writeFile(path.join(caseDir, "repo", "test.mjs"), "// weak public test\n", "utf8");
  await mkdir(path.join(caseDir, "oracle"), { recursive: true });
  await writeFile(path.join(caseDir, "oracle", "test.mjs"), "// STRONG oracle test\n", "utf8");
  await writeFile(path.join(caseDir, "issue.md"), "fix it", "utf8");
  await writeFile(
    path.join(caseDir, "check.json"),
    JSON.stringify({ name: "unit", command: "node test.mjs" }),
    "utf8",
  );

  const m = await loadCase(caseDir);
  assert.ok(m.oracleDir, "oracle/ should be detected");

  const ws = await mkdtemp(path.join(tmpdir(), "lb-oracle-ws-"));
  await copyRepoInto(m, ws);
  // The agent tries to weaken/replace the graded test.
  await writeFile(path.join(ws, "test.mjs"), "// agent overwrote the test to always pass\n", "utf8");

  const applied = await applyOracleOverlay(m, ws);
  assert.equal(applied, true);
  assert.equal(
    await readFile(path.join(ws, "test.mjs"), "utf8"),
    "// STRONG oracle test\n",
    "oracle must overwrite the agent's tampered test (agent cannot disable the oracle)",
  );
});

test("loadCase parses the new fields and defaults them when absent (back-compat)", async () => {
  const withFields = await mkdtemp(path.join(tmpdir(), "lb-fields-"));
  await mkdir(path.join(withFields, "repo"), { recursive: true });
  await writeFile(path.join(withFields, "issue.md"), "x", "utf8");
  await writeFile(
    path.join(withFields, "check.json"),
    JSON.stringify({
      command: "true",
      category: "async-race",
      difficulty: "hard",
      issueHintsLevel: "vague",
      expectedChangedPaths: ["a.js"],
      forbiddenChangedPaths: ["test.mjs"],
      requiredTestPaths: ["tests/t.py"],
    }),
    "utf8",
  );
  const m = await loadCase(withFields);
  assert.equal(m.check.category, "async-race");
  assert.equal(m.check.difficulty, "hard");
  assert.equal(m.check.issueHintsLevel, "vague");
  assert.deepEqual(m.check.expectedChangedPaths, ["a.js"]);
  assert.deepEqual(m.check.forbiddenChangedPaths, ["test.mjs"]);
  assert.deepEqual(m.check.requiredTestPaths, ["tests/t.py"]);

  // Absent → safe defaults; the original 40 cases behave exactly as before.
  const bare = await mkdtemp(path.join(tmpdir(), "lb-bare-"));
  await mkdir(path.join(bare, "repo"), { recursive: true });
  await writeFile(path.join(bare, "issue.md"), "x", "utf8");
  await writeFile(path.join(bare, "check.json"), JSON.stringify({ command: "true" }), "utf8");
  const d = await loadCase(bare);
  assert.equal(d.check.difficulty, "easy");
  assert.equal(d.check.issueHintsLevel, "direct");
  assert.equal(d.check.category, "uncategorized");
  assert.deepEqual(d.check.expectedChangedPaths, []);
  assert.deepEqual(d.check.requiredTestPaths, []);
  assert.equal(d.oracleDir, undefined);
});

test("report groups solved/total by difficulty and category", () => {
  const rows: ResultRow[] = [
    { id: "h1", tests_passed: true, quality_passed: true, solved: true, quality_flags: [], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["x"], difficulty: "hard", category: "async-race" },
    { id: "h2", tests_passed: true, quality_passed: false, solved: false, quality_flags: ["repro_invalid"], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["y"], difficulty: "hard", category: "async-race" },
    { id: "e1", tests_passed: true, quality_passed: true, solved: true, quality_flags: [], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["z"], difficulty: "easy", category: "wrong-operator" },
  ];
  const out = formatReport(rows);
  assert.match(out, /by difficulty/);
  assert.match(out, /hard\s+1\/2/);
  assert.match(out, /easy\s+1\/1/);
  assert.match(out, /by category/);
  assert.match(out, /async-race\s+1\/2/);
  // repro_invalid surfaces in the flag legend/column
  assert.match(out, /repro=repro_invalid/);
});

test("report separates 'bug-fixed by oracle' from 'quality-blocked' (correct but flagged)", () => {
  const rows: ResultRow[] = [
    // correct AND clean
    { id: "a", tests_passed: true, quality_passed: true, solved: true, quality_flags: [], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["x"] },
    // correct fix, but a policy flag blocked it → quality-blocked
    { id: "b", tests_passed: true, quality_passed: false, solved: false, quality_flags: ["unrelated_files"], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["y"] },
    // genuinely wrong (oracle rejected)
    { id: "c", tests_passed: false, quality_passed: false, solved: false, quality_flags: [], attempts: 1, patch_bytes: 10, timed_out: false, changed_files: ["z"] },
  ];
  const out = formatReport(rows);
  assert.match(out, /bug-fixed by oracle:\s+2\/3/); // a + b had a correct fix
  assert.match(out, /quality-blocked:\s+1\/3/); // only b was correct-but-flagged
});
