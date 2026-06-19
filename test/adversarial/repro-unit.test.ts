import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReproIsRed,
  reproPassed,
  isTautologicalRepro,
  deriveReproCommand,
  safeReproPath,
  isScratchReproPath,
} from "../../src/solve/repro.js";

test("validateReproIsRed: only a clean non-zero exit counts as red", () => {
  assert.equal(validateReproIsRed({ exitCode: 1, timedOut: false }).red, true);
  assert.equal(validateReproIsRed({ exitCode: 2, timedOut: false }).red, true);
  // A pass on the buggy tree means it does not capture the bug.
  assert.equal(validateReproIsRed({ exitCode: 0, timedOut: false }).red, false);
  // A timeout or spawn failure cannot establish a red baseline.
  assert.equal(validateReproIsRed({ exitCode: 1, timedOut: true }).red, false);
  assert.equal(validateReproIsRed({ exitCode: null, timedOut: false }).red, false);
  // Each rejection carries a human-readable reason.
  assert.match(validateReproIsRed({ exitCode: 0, timedOut: false }).reason!, /passed on the buggy tree/);
});

test("reproPassed: green only on a clean exit 0", () => {
  assert.equal(reproPassed({ exitCode: 0, timedOut: false }), true);
  assert.equal(reproPassed({ exitCode: 1, timedOut: false }), false);
  assert.equal(reproPassed({ exitCode: 0, timedOut: true }), false);
  assert.equal(reproPassed({ exitCode: null, timedOut: false }), false);
});

test("isTautologicalRepro: flags empty, constant-truth, and assertion-less tests", () => {
  assert.equal(isTautologicalRepro("").tautological, true);
  assert.equal(isTautologicalRepro("   \n  ").tautological, true);
  assert.equal(isTautologicalRepro("assert(true)").tautological, true);
  assert.equal(isTautologicalRepro("assert True").tautological, true);
  assert.equal(isTautologicalRepro("expect(true).toBe(true)").tautological, true);
  // No assertion at all → no oracle.
  assert.equal(isTautologicalRepro("process.exit(1)").tautological, true);
  // A real assertion against product behavior is not flagged.
  assert.equal(isTautologicalRepro("assert.equal(add(2,2), 4)").tautological, false);
  assert.equal(isTautologicalRepro("expect(parse(s)).toEqual(['a','b'])").tautological, false);
});

test("deriveReproCommand: maps known test extensions, null otherwise", () => {
  assert.equal(deriveReproCommand("tests/x.test.mjs"), 'node --test "tests/x.test.mjs"');
  assert.equal(deriveReproCommand("a/b.js"), 'node --test "a/b.js"');
  assert.equal(deriveReproCommand("a/b.cjs"), 'node --test "a/b.cjs"');
  assert.equal(deriveReproCommand("t.ts"), 'node --import tsx --test "t.ts"');
  assert.equal(deriveReproCommand("tests/test_x.py"), 'python -m pytest "tests/test_x.py" -q');
  assert.equal(deriveReproCommand("notes.md"), null);
  assert.equal(deriveReproCommand("Makefile"), null);
});

test("safeReproPath: rejects absolute paths and parent-escape", () => {
  assert.equal(safeReproPath("tests/repro.test.mjs"), "tests/repro.test.mjs");
  assert.equal(safeReproPath(".deepcoder/repro/x.test.mjs"), ".deepcoder/repro/x.test.mjs");
  assert.equal(safeReproPath("/etc/passwd"), null);
  assert.equal(safeReproPath("../escape.mjs"), null);
  assert.equal(safeReproPath("a/../../b.mjs"), null);
  assert.equal(safeReproPath("C:/win.mjs"), null);
  assert.equal(safeReproPath(""), null);
});

test("isScratchReproPath: only .deepcoder paths are scratch", () => {
  assert.equal(isScratchReproPath(".deepcoder/repro/x.test.mjs"), true);
  assert.equal(isScratchReproPath("tests/repro.test.mjs"), false);
});
