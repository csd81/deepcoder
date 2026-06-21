/**
 * Phase 9G — Adversarial tests for completeness gates and self-audit parsing.
 *
 * Covers the pure adversarial cases from the 9G plan:
 * 1. passing-check-but-missing-required-README deliverable => incomplete
 * 2. passing-check-but-missing-required-test change => incomplete
 * 3. self-audit claiming a deliverable with NO matching patch evidence => rejected
 * 4. evaluateCompleteness tolerates a null / undefined self-audit (warning only)
 * 5. a must_not_change file that appears in the patch => forbidden_file_changed
 * 6. a manual_review deliverable => produces manual_review_required
 * 7. a fully-satisfied task => complete:true
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluateCompleteness } from "../../src/delegate/completeness.js";
import { type WorkerTask, type WorkerSelfAudit } from "../../src/delegate/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Minimal valid worker task with no deliverables/expected files. */
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

/** A valid self-audit that claims everything is done. */
function passingAudit(overrides: Partial<WorkerSelfAudit> = {}): WorkerSelfAudit {
  return {
    taskId: "worker-test",
    completedDeliverables: [],
    skippedDeliverables: [],
    changedFiles: ["src/main.ts"],
    testsRun: ["npm run test"],
    knownLimitations: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  1. Missing required README deliverable                             */
/* ------------------------------------------------------------------ */

describe("missing required deliverable", () => {
  test("passing-check-but-missing-required-README deliverable => incomplete", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Update README.md with usage docs",
          required: true,
          evidence: { kind: "file_changed", path: "README.md" },
        },
        {
          id: "D2",
          description: "Implement the feature",
          required: true,
          evidence: { kind: "file_changed", path: "src/main.ts" },
        },
      ],
    });

    // Worker changed src/main.ts but NOT README.md
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "diff --git a/src/main.ts b/src/main.ts\n+new feature",
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some(
        (f) => f.code === "missing_required_deliverable" && f.deliverableId === "D1",
      ),
      "Should have missing_required_deliverable for D1 (README)",
    );
    // D2 should be satisfied
    assert.ok(
      !result.failures.some((f) => f.deliverableId === "D2"),
      "D2 should be satisfied",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  2. Missing required test change                                    */
/* ------------------------------------------------------------------ */

describe("missing required test", () => {
  test("passing-check-but-missing-required-test change => incomplete", () => {
    const task = baseTask({
      expectedTests: [
        {
          pathPrefix: "test/",
          description: "Add tests for the new feature",
        },
      ],
    });

    // Worker changed only src/main.ts, nothing under test/
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "",
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "missing_required_test"),
      "Should have missing_required_test",
    );
  });

  test("test change under custom prefix satisfies expectedTests", () => {
    const task = baseTask({
      expectedTests: [
        {
          pathPrefix: "tests/adversarial/",
          description: "Add adversarial tests",
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["tests/adversarial/my-test.test.ts"],
      patchText: "",
    });

    assert.equal(result.complete, true);
    assert.equal(result.failures.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  3. Self-audit claims deliverable without patch evidence            */
/* ------------------------------------------------------------------ */

describe("self-audit cross-check", () => {
  test("self-audit claiming a deliverable with NO matching patch evidence => rejected", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Update README",
          required: true,
          evidence: { kind: "file_changed", path: "README.md" },
        },
      ],
    });

    const audit = passingAudit({
      completedDeliverables: [{ id: "D1", evidence: "I updated the README" }],
    });

    // Worker changed nothing related to README.md
    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "",
      selfAudit: audit,
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "malformed_self_audit"),
      "Should have malformed_self_audit failure",
    );
  });

  test("self-audit claiming unknown deliverable => malformed_self_audit", () => {
    const task = baseTask({
      deliverables: [],
    });

    const audit = passingAudit({
      completedDeliverables: [{ id: "NONEXISTENT", evidence: "done" }],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
      selfAudit: audit,
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "malformed_self_audit"),
      "Should flag unknown deliverable in self-audit",
    );
  });

  test("self-audit matching evidence => no cross-check failure", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Change main.ts",
          required: true,
          evidence: { kind: "file_changed", path: "src/main.ts" },
        },
      ],
    });

    const audit = passingAudit({
      completedDeliverables: [{ id: "D1", evidence: "changed main.ts" }],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "diff --git a/src/main.ts",
      selfAudit: audit,
    });

    assert.equal(result.complete, true);
    assert.equal(
      result.failures.filter((f) => f.code === "malformed_self_audit").length,
      0,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  4. evaluateCompleteness self-audit handling (null / undefined)     */
/* ------------------------------------------------------------------ */

describe("evaluateCompleteness self-audit handling", () => {

  test("null self-audit in evaluateCompleteness does not crash", () => {
    const task = baseTask();
    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
      selfAudit: null,
    });
    // Should not crash; missing self-audit is a warning
    assert.ok(result.warnings.some((w) => w.includes("No self-audit")));
  });

  test("undefined self-audit in evaluateCompleteness does not crash", () => {
    const task = baseTask();
    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
    });
    assert.equal(result.complete, true);
    assert.ok(result.warnings.some((w) => w.includes("No self-audit")));
  });
});

/* ------------------------------------------------------------------ */
/*  5. Forbidden file changed                                          */
/* ------------------------------------------------------------------ */

describe("forbidden file change", () => {
  test("a must_not_change file that appears in the patch => forbidden_file_changed", () => {
    const task = baseTask({
      expectedFiles: [
        {
          path: "src/config.ts",
          mode: "must_not_change",
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/config.ts", "src/main.ts"],
      patchText: "diff --git a/src/config.ts",
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "forbidden_file_changed"),
      "Should have forbidden_file_changed",
    );
  });

  test("must_not_change file NOT in patch => no failure", () => {
    const task = baseTask({
      expectedFiles: [
        {
          path: "src/config.ts",
          mode: "must_not_change",
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "",
    });

    assert.equal(result.complete, true);
    assert.equal(
      result.failures.filter((f) => f.code === "forbidden_file_changed").length,
      0,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  6. Manual review deliverable                                       */
/* ------------------------------------------------------------------ */

describe("manual review deliverable", () => {
  test("a manual_review deliverable => produces manual_review_required", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Review the architectural changes",
          required: true,
          evidence: { kind: "manual_review" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "",
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "manual_review_required"),
      "Should have manual_review_required",
    );
  });

  test("non-required manual_review does not block", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Optional review",
          required: false,
          evidence: { kind: "manual_review" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
    });

    // Non-required deliverables are skipped entirely
    assert.equal(result.complete, true);
  });
});

/* ------------------------------------------------------------------ */
/*  7. Fully satisfied task                                            */
/* ------------------------------------------------------------------ */

describe("fully satisfied task", () => {
  test("all required deliverables have evidence, expected files/tests changed => complete:true", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Implement feature in main.ts",
          required: true,
          evidence: { kind: "file_changed", path: "src/main.ts" },
        },
        {
          id: "D2",
          description: "Add tests",
          required: true,
          evidence: { kind: "test_added", pathPrefix: "test/" },
        },
        {
          id: "D3",
          description: "Add telemetry field",
          required: true,
          evidence: { kind: "text_in_diff", pattern: "preflightContextBytes" },
        },
      ],
      expectedFiles: [
        { path: "src/main.ts", mode: "must_change" },
        { path: "src/config.ts", mode: "must_not_change" },
      ],
      expectedTests: [
        { pathPrefix: "test/", description: "Add tests" },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts", "test/feature.test.ts"],
      patchText:
        "diff --git a/src/main.ts b/src/main.ts\n+preflightContextBytes: 100\n+new feature",
    });

    assert.equal(result.complete, true);
    assert.equal(result.failures.length, 0);
  });

  test("file_exists with injected predicate works", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "README exists",
          required: true,
          evidence: { kind: "file_exists", path: "README.md" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
      fileExists: (p) => p === "README.md",
    });

    assert.equal(result.complete, true);
    assert.equal(result.failures.length, 0);
  });

  test("file_exists without injected predicate => fail closed", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "README exists",
          required: true,
          evidence: { kind: "file_exists", path: "README.md" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
      // No fileExists injected
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "missing_required_deliverable"),
    );
  });

  test("must_exist with injected predicate works", () => {
    const task = baseTask({
      expectedFiles: [
        { path: "README.md", mode: "must_exist" },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
      fileExists: (p) => p === "README.md",
    });

    assert.equal(result.complete, true);
  });

  test("must_exist without injected predicate => fail closed", () => {
    const task = baseTask({
      expectedFiles: [
        { path: "README.md", mode: "must_exist" },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
    });

    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === "missing_expected_file_change"),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
  test("empty task with no deliverables => complete", () => {
    const task = baseTask();
    const result = evaluateCompleteness({
      task,
      changedPaths: [],
      patchText: "",
    });
    assert.equal(result.complete, true);
  });

  test("path_prefix_changed matches nested paths", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Change something under src/",
          required: true,
          evidence: { kind: "path_prefix_changed", prefix: "src" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/deep/nested/file.ts"],
      patchText: "",
    });

    assert.equal(result.complete, true);
  });

  test("path_prefix_changed does not match unrelated prefix", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Change under src/",
          required: true,
          evidence: { kind: "path_prefix_changed", prefix: "src" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["test/file.ts"],
      patchText: "",
    });

    assert.equal(result.complete, false);
  });

  test("json_field deliverable satisfied when file changed and token in diff", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Add telemetry field",
          required: true,
          evidence: { kind: "json_field", path: "src/config.ts", jsonPath: "preflightContextBytes" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/config.ts"],
      patchText: "diff --git a/src/config.ts\n+preflightContextBytes: 100",
    });

    assert.equal(result.complete, true);
  });

  test("json_field deliverable not satisfied when file not changed", () => {
    const task = baseTask({
      deliverables: [
        {
          id: "D1",
          description: "Add telemetry field",
          required: true,
          evidence: { kind: "json_field", path: "src/config.ts", jsonPath: "preflightContextBytes" },
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["src/main.ts"],
      patchText: "",
    });

    assert.equal(result.complete, false);
  });

  test("mustGoRedOnBaseline produces warning but does not block", () => {
    const task = baseTask({
      expectedTests: [
        {
          pathPrefix: "test/",
          mustGoRedOnBaseline: true,
          description: "Regression test that should fail on baseline",
        },
      ],
    });

    const result = evaluateCompleteness({
      task,
      changedPaths: ["test/regression.test.ts"],
      patchText: "",
    });

    // Test change is present, so no failure
    assert.equal(result.complete, true);
    // But there should be a warning about mustGoRedOnBaseline
    assert.ok(
      result.warnings.some((w) => w.includes("mustGoRedOnBaseline")),
      "Should warn about mustGoRedOnBaseline",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  8. Expected symbols (Phase 9G — was defined but never consumed)    */
/* ------------------------------------------------------------------ */

describe("expected symbols", () => {
  const SYMBOL_TASK = (): WorkerTask =>
    baseTask({
      expectedSymbols: [{ file: "src/auth.ts", symbol: "verifyToken", mode: "must_add_or_change" }],
    });

  test("symbol added on a changed-file diff line => satisfied", () => {
    const patch = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,2 +1,5 @@",
      "+export function verifyToken(t: string): boolean {",
      "+  return t.length > 0;",
      "+}",
    ].join("\n");
    const result = evaluateCompleteness({
      task: SYMBOL_TASK(),
      changedPaths: ["src/auth.ts"],
      patchText: patch,
    });
    assert.equal(result.complete, true, result.failures.map((f) => f.message).join("; "));
  });

  test("expected file not changed => missing_expected_symbol", () => {
    const result = evaluateCompleteness({
      task: SYMBOL_TASK(),
      changedPaths: ["src/other.ts"],
      patchText: "+export function verifyToken() {}",
    });
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "missing_expected_symbol"));
  });

  test("file changed but symbol absent from added lines => missing_expected_symbol", () => {
    const patch = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1,2 @@",
      "+export function somethingElse() {}",
    ].join("\n");
    const result = evaluateCompleteness({
      task: SYMBOL_TASK(),
      changedPaths: ["src/auth.ts"],
      patchText: patch,
    });
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "missing_expected_symbol"));
  });

  test("symbol present only in another file's diff => missing_expected_symbol (scoped per file)", () => {
    const patch = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1,2 @@",
      "+const unrelated = 1;",
      "diff --git a/src/other.ts b/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1,2 @@",
      "+export function verifyToken() {}",
    ].join("\n");
    const result = evaluateCompleteness({
      task: SYMBOL_TASK(),
      changedPaths: ["src/auth.ts", "src/other.ts"],
      patchText: patch,
    });
    assert.equal(result.complete, false, "verifyToken added in other.ts must not satisfy the auth.ts rule");
    assert.ok(result.failures.some((f) => f.code === "missing_expected_symbol"));
  });
});
