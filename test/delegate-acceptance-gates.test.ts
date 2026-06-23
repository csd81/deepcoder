/**
 * Acceptance gates — reachability + deliverable test-delta.
 *
 * Two new DETERMINISTIC, PURE gates in evaluateCompleteness:
 *
 * GATE 1 (reachability): each `task.expectedReachable` module must be imported
 *   by at least one NON-test source file (via the injected `findImporters`
 *   predicate). Missing predicate => fail closed. Orphaned/inert => failure.
 *
 * GATE 2 (deliverable test-delta): each in-scope expectedSymbols rule
 *   (mustBeTested OR requireDeliverableTested flag) must have its symbol on an
 *   ADDED line inside at least one changed TEST file. Downgraded to a warning
 *   when expectedTests/tdd already own test coverage.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluateCompleteness } from "../src/delegate/completeness.js";
import { type WorkerTask } from "../src/delegate/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function baseTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "worker-test",
    title: "Test worker",
    prompt: "Do the thing",
    allowedPaths: ["src"],
    forbiddenPaths: ["node_modules"],
    checkName: "phase",
    maxAttempts: 3,
    dependsOn: [],
    expectedOutputs: [],
    status: "planned",
    ...overrides,
  };
}

/** Build a minimal unified diff that adds `lines` to `file`. */
function diffAdding(file: string, lines: string[]): string {
  const body = lines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  GATE 1 — reachability                                             */
/* ------------------------------------------------------------------ */

describe("reachability gate", () => {
  test("orphaned module (no importers) => orphaned_deliverable failure", () => {
    const task = baseTask({
      expectedReachable: [{ module: "src/feature.ts" }],
    });
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText: diffAdding("src/feature.ts", ["export function feature() {}"]),
      findImporters: () => [],
    });
    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "orphaned_deliverable"),
      "expected an orphaned_deliverable failure",
    );
  });

  test("only a test file imports the module => still orphaned", () => {
    const task = baseTask({
      expectedReachable: [{ module: "src/feature.ts" }],
    });
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText: diffAdding("src/feature.ts", ["export function feature() {}"]),
      findImporters: () => ["test/feature.test.ts"],
    });
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "orphaned_deliverable"));
  });

  test("one non-test importer => no orphaned_deliverable failure", () => {
    const task = baseTask({
      expectedReachable: [{ module: "src/feature.ts" }],
    });
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText: diffAdding("src/feature.ts", ["export function feature() {}"]),
      findImporters: () => ["src/index.ts", "test/feature.test.ts"],
    });
    assert.ok(
      !result.failures.some((f) => f.code === "orphaned_deliverable"),
      "should not be orphaned when a non-test source imports it",
    );
  });

  test("fail closed: expectedReachable present but findImporters omitted", () => {
    const task = baseTask({
      expectedReachable: [{ module: "src/feature.ts" }],
    });
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText: diffAdding("src/feature.ts", ["export function feature() {}"]),
      // findImporters intentionally omitted
    });
    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "orphaned_deliverable"),
      "expected fail-closed orphaned_deliverable when findImporters missing",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  GATE 2 — deliverable test-delta                                  */
/* ------------------------------------------------------------------ */

describe("deliverable test-delta gate", () => {
  test("mustBeTested symbol not in any added test line => deliverable_untested", () => {
    const task = baseTask({
      expectedSymbols: [
        { file: "src/feature.ts", symbol: "feature", mode: "must_add_or_change", mustBeTested: true },
      ],
    });
    // Symbol is added in production, but no test file touches it.
    const patchText = diffAdding("src/feature.ts", ["export function feature() {}"]);
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText,
    });
    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "deliverable_untested"),
      "expected deliverable_untested failure",
    );
  });

  test("symbol present on an added line in a test file => pass", () => {
    const task = baseTask({
      expectedSymbols: [
        { file: "src/feature.ts", symbol: "feature", mode: "must_add_or_change", mustBeTested: true },
      ],
    });
    const patchText =
      diffAdding("src/feature.ts", ["export function feature() {}"]) +
      diffAdding("test/feature.test.ts", ["assert.equal(feature(), 1);"]);
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts", "test/feature.test.ts"],
      patchText,
    });
    assert.ok(
      !result.failures.some((f) => f.code === "deliverable_untested"),
      "should not fail when symbol is exercised by an added test line",
    );
  });

  test("requireDeliverableTested flag puts a plain symbol rule in scope", () => {
    const task = baseTask({
      expectedSymbols: [
        { file: "src/feature.ts", symbol: "feature", mode: "must_add_or_change" },
      ],
    });
    const patchText = diffAdding("src/feature.ts", ["export function feature() {}"]);
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText,
      requireDeliverableTested: true,
    });
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "deliverable_untested"));
  });

  test("downgrade: untested symbol but expectedTests non-empty => WARNING not failure", () => {
    const task = baseTask({
      expectedSymbols: [
        { file: "src/feature.ts", symbol: "feature", mode: "must_add_or_change", mustBeTested: true },
      ],
      expectedTests: [{ pathPrefix: "test/", description: "feature tests" }],
    });
    const patchText =
      diffAdding("src/feature.ts", ["export function feature() {}"]) +
      diffAdding("test/other.test.ts", ["// unrelated test"]);
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts", "test/other.test.ts"],
      patchText,
    });
    assert.ok(
      !result.failures.some((f) => f.code === "deliverable_untested"),
      "should be a warning, not a failure, when expectedTests owns coverage",
    );
    assert.ok(
      result.warnings.some((w) => w.includes("feature")),
      "expected a warning mentioning the untested symbol",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Regression — new fields absent => unchanged behavior              */
/* ------------------------------------------------------------------ */

describe("regression: no new fields", () => {
  test("input without new fields produces no new failures/warnings", () => {
    const task = baseTask({
      expectedSymbols: [
        { file: "src/feature.ts", symbol: "feature", mode: "must_add_or_change" },
      ],
    });
    const patchText = diffAdding("src/feature.ts", ["export function feature() {}"]);
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/feature.ts"],
      patchText,
    });
    assert.equal(result.complete, true, "should be complete with no new gates triggered");
    assert.ok(
      !result.failures.some(
        (f) => f.code === "orphaned_deliverable" || f.code === "deliverable_untested",
      ),
      "no new-gate failures should appear",
    );
    assert.ok(
      !result.warnings.some((w) => w.includes("feature")),
      "no test-delta warning should appear",
    );
  });
});
