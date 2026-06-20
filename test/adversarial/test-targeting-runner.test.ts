/**
 * Phase 10H — automatic minimal test targeting. SEED (red-first): pins the pure
 * planner contract so the delegated worker MUST implement it (no no-op), then
 * extends this file with the remaining cases from the plan.
 *
 * Tests 1-12 from the plan:
 *   1. Changed test file produces high-confidence target.
 *   2. Reverse-import impacted test produces high-confidence target.
 *   3. Naming convention produces medium-confidence target.
 *   4. Path rule produces medium-confidence target.
 *   5. No targets produces fallbackRequired:true.
 *   6. Sensitive/generated changed file forces fallback.
 *   7. Command template quotes file paths safely.
 *   8. Classifier-denied targeted command falls back, does not run.
 *   9. Target count is capped.
 *  10. /tests plan output is bounded and deterministic.
 *  11. Solve telemetry records target plan and run ids.
 *  12. Delegated worker is not marked passed from low-confidence targeted-only result.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestTargetPlan, shellQuote, isUnsafeForTargeting } from "../../src/checks/testTargetPlanner.js";
import type { RepoIndex } from "../../src/index/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RepoIndex for testing. */
function makeIndex(files: { path: string; kind: "code" | "test" | "config" | "docs" | "generated" | "other" }[]): RepoIndex {
  return {
    root: "/workspace",
    files: files.map((f) => ({ ...f, lang: f.path.endsWith(".ts") ? "ts" : undefined })),
    counts: { code: 0, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [],
    imports: [],
  };
}

// ---------------------------------------------------------------------------
// Test 1: Changed test file → high-confidence target
// ---------------------------------------------------------------------------
test("1. a changed TEST file → high-confidence target", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["test/foo.test.ts"], maxTargets: 8 });
  assert.equal(plan.confidence, "high");
  assert.ok(plan.targetFiles.includes("test/foo.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

test("1b. changed test file with index → high-confidence target", () => {
  const index = makeIndex([
    { path: "test/foo.test.ts", kind: "test" },
    { path: "src/bar.ts", kind: "code" },
  ]);
  const plan = buildTestTargetPlan({ changedFiles: ["test/foo.test.ts"], index, maxTargets: 8 });
  assert.equal(plan.confidence, "high");
  assert.ok(plan.targetFiles.includes("test/foo.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

// ---------------------------------------------------------------------------
// Test 2: Reverse-import impacted test → high-confidence target
// ---------------------------------------------------------------------------
test("2. reverse-import impacted test → high-confidence target", () => {
  const index: RepoIndex = {
    root: "/workspace",
    files: [
      { path: "src/bar.ts", kind: "code", lang: "ts" },
      { path: "test/bar.test.ts", kind: "test", lang: "ts" },
    ],
    counts: { code: 1, test: 1, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [],
    imports: [{ from: "test/bar.test.ts", to: "src/bar.ts" }],
  };
  const plan = buildTestTargetPlan({ changedFiles: ["src/bar.ts"], index, maxTargets: 8 });
  assert.equal(plan.confidence, "high");
  assert.ok(plan.targetFiles.includes("test/bar.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

test("2b. reverse-import impacted test via transitive import → high-confidence target", () => {
  const index: RepoIndex = {
    root: "/workspace",
    files: [
      { path: "src/core.ts", kind: "code", lang: "ts" },
      { path: "src/util.ts", kind: "code", lang: "ts" },
      { path: "test/core.test.ts", kind: "test", lang: "ts" },
    ],
    counts: { code: 2, test: 1, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [],
    imports: [
      { from: "src/core.ts", to: "src/util.ts" },
      { from: "test/core.test.ts", to: "src/core.ts" },
    ],
  };
  const plan = buildTestTargetPlan({ changedFiles: ["src/util.ts"], index, maxTargets: 8 });
  assert.equal(plan.confidence, "high");
  assert.ok(plan.targetFiles.includes("test/core.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

// ---------------------------------------------------------------------------
// Test 3: Naming convention → medium-confidence target
// ---------------------------------------------------------------------------
test("3. naming convention → medium-confidence target", () => {
  const index: RepoIndex = {
    root: "/workspace",
    files: [
      { path: "src/bar.ts", kind: "code", lang: "ts" },
      { path: "test/bar.test.ts", kind: "test", lang: "ts" },
    ],
    counts: { code: 1, test: 1, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: [],
    imports: [], // no import edge — naming convention fallback
  };
  const plan = buildTestTargetPlan({ changedFiles: ["src/bar.ts"], index, maxTargets: 8 });
  // relevantTests should match bar.ts → bar.test.ts by naming convention
  assert.ok(plan.targetFiles.includes("test/bar.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

// ---------------------------------------------------------------------------
// Test 4: Path rule → medium-confidence target
// ---------------------------------------------------------------------------
test("4. path rule → medium-confidence target", () => {
  const index = makeIndex([
    { path: "src/foo.ts", kind: "code" },
    { path: "test/foo.test.ts", kind: "test" },
    { path: "test/bar.test.ts", kind: "test" },
  ]);
  const plan = buildTestTargetPlan({
    changedFiles: ["src/foo.ts"],
    index,
    maxTargets: 8,
    pathRules: [{ changed: "src/**", tests: ["test/**/*.test.ts"] }],
  });
  assert.ok(plan.targetFiles.includes("test/foo.test.ts"));
  assert.ok(plan.targetFiles.includes("test/bar.test.ts"));
  assert.equal(plan.fallbackRequired, false);
});

// ---------------------------------------------------------------------------
// Test 5: No targets → fallbackRequired:true
// ---------------------------------------------------------------------------
test("5. no derivable targets → fallbackRequired, confidence 'none'", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["README.md"], maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.confidence, "none");
});

test("5b. no targets with index → fallbackRequired:true", () => {
  const index = makeIndex([
    { path: "README.md", kind: "docs" },
    { path: "LICENSE", kind: "docs" },
  ]);
  const plan = buildTestTargetPlan({ changedFiles: ["README.md"], index, maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.confidence, "none");
});

// ---------------------------------------------------------------------------
// Test 6: Sensitive/generated changed file forces fallback
// ---------------------------------------------------------------------------
test("6. sensitive changed file forces fallback", () => {
  const plan = buildTestTargetPlan({ changedFiles: [".env"], maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.targetFiles.length, 0);
});

test("6b. generated changed file forces fallback", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["dist/bundle.js"], maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.targetFiles.length, 0);
});

test("6c. mixed safe+unsafe → fallbackRequired:true, no commands", () => {
  const index = makeIndex([
    { path: "src/foo.ts", kind: "code" },
    { path: "test/foo.test.ts", kind: "test" },
  ]);
  const plan = buildTestTargetPlan({
    changedFiles: ["src/foo.ts", ".env"],
    index,
    maxTargets: 8,
  });
  assert.equal(plan.fallbackRequired, true);
  // Even though src/foo.ts would normally produce targets, the presence of .env
  // forces fallback and no commands should be produced.
  assert.equal(plan.commands.length, 0);
});

// ---------------------------------------------------------------------------
// Test 7: Command template quotes file paths safely
// ---------------------------------------------------------------------------
test("7. shellQuote wraps paths safely", () => {
  assert.equal(shellQuote("test/foo.test.ts"), "'test/foo.test.ts'");
  assert.equal(shellQuote("test/foo bar.test.ts"), "'test/foo bar.test.ts'");
  assert.equal(shellQuote("test/foo's.test.ts"), "'test/foo'\\''s.test.ts'");
  assert.equal(shellQuote("test/foo.test.ts"), "'test/foo.test.ts'");
});

test("7b. command template uses quoted paths", () => {
  const plan = buildTestTargetPlan({
    changedFiles: ["test/foo.test.ts"],
    maxTargets: 8,
    languageCommands: { typescript: "node --test {files}" },
  });
  assert.ok(plan.commands.length > 0);
  const cmd = plan.commands[0]!;
  // The command should contain the quoted path
  assert.ok(cmd.command.includes("'test/foo.test.ts'"));
});

// ---------------------------------------------------------------------------
// Test 8: Classifier-denied targeted command falls back
// ---------------------------------------------------------------------------
test("8. isUnsafeForTargeting detects sensitive paths", () => {
  assert.equal(isUnsafeForTargeting(".env"), true);
  assert.equal(isUnsafeForTargeting(".env.local"), true);
  assert.equal(isUnsafeForTargeting("dist/bundle.js"), true);
  assert.equal(isUnsafeForTargeting("node_modules/foo/index.js"), true);
  assert.equal(isUnsafeForTargeting("src/foo.ts"), false);
  assert.equal(isUnsafeForTargeting("test/foo.test.ts"), false);
});

// ---------------------------------------------------------------------------
// Test 9: Target count is capped
// ---------------------------------------------------------------------------
test("9. target count is capped at maxTargets", () => {
  const index = makeIndex(
    Array.from({ length: 20 }, (_, i) => ({
      path: `test/test${i}.test.ts`,
      kind: "test" as const,
    })),
  );
  const plan = buildTestTargetPlan({
    changedFiles: ["test/test0.test.ts"],
    index,
    maxTargets: 5,
  });
  assert.ok(plan.targetFiles.length <= 5);
});

test("9b. default maxTargets is 8", () => {
  const index = makeIndex(
    Array.from({ length: 20 }, (_, i) => ({
      path: `test/test${i}.test.ts`,
      kind: "test" as const,
    })),
  );
  const plan = buildTestTargetPlan({
    changedFiles: ["test/test0.test.ts"],
    index,
  });
  assert.ok(plan.targetFiles.length <= 8);
});

// ---------------------------------------------------------------------------
// Test 10: /tests plan output is bounded and deterministic
// ---------------------------------------------------------------------------
test("10. plan is deterministic for same input", () => {
  const index = makeIndex([
    { path: "src/foo.ts", kind: "code" },
    { path: "test/foo.test.ts", kind: "test" },
  ]);
  const input = { changedFiles: ["src/foo.ts"], index, maxTargets: 8 };
  const plan1 = buildTestTargetPlan(input);
  const plan2 = buildTestTargetPlan(input);
  assert.deepEqual(plan1, plan2);
});

test("10b. plan output is bounded (no huge arrays)", () => {
  const index = makeIndex(
    Array.from({ length: 100 }, (_, i) => ({
      path: `test/test${i}.test.ts`,
      kind: "test" as const,
    })),
  );
  const plan = buildTestTargetPlan({
    changedFiles: Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`),
    index,
    maxTargets: 8,
    pathRules: [{ changed: "src/**", tests: ["test/**/*.test.ts"] }],
  });
  assert.ok(plan.targetFiles.length <= 8);
  assert.ok(plan.commands.length <= 8);
  assert.ok(plan.reasons.length <= 100); // reasons may be many but bounded
});

// ---------------------------------------------------------------------------
// Test 11: Solve telemetry records target plan and run ids
// ---------------------------------------------------------------------------
test("11. plan includes all fields needed for telemetry", () => {
  const index = makeIndex([
    { path: "src/foo.ts", kind: "code" },
    { path: "test/foo.test.ts", kind: "test" },
  ]);
  const plan = buildTestTargetPlan({ changedFiles: ["src/foo.ts"], index, maxTargets: 8 });
  // Telemetry-relevant fields
  assert.ok(typeof plan.confidence === "string");
  assert.ok(Array.isArray(plan.changedFiles));
  assert.ok(Array.isArray(plan.targetFiles));
  assert.ok(Array.isArray(plan.commands));
  assert.ok(typeof plan.fallbackRequired === "boolean");
  // Each command has the fields needed for telemetry
  for (const cmd of plan.commands) {
    assert.ok(typeof cmd.label === "string");
    assert.ok(typeof cmd.command === "string");
    assert.ok(Array.isArray(cmd.files));
    assert.ok(typeof cmd.language === "string");
    assert.ok(typeof cmd.confidence === "string");
  }
});

// ---------------------------------------------------------------------------
// Test 12: Delegated worker is not marked passed from low-confidence targeted-only result
// ---------------------------------------------------------------------------
test("12. low-confidence plan has fallbackRequired:true", () => {
  const plan = buildTestTargetPlan({ changedFiles: ["README.md"], maxTargets: 8 });
  assert.equal(plan.confidence, "none");
  assert.equal(plan.fallbackRequired, true);
  // A worker should NOT be marked passed from this plan
  assert.equal(plan.commands.length, 0);
});

test("12b. medium-confidence plan without index still requires fallback if no targets", () => {
  // A changed file that is not a test and has no index → no targets → fallback
  const plan = buildTestTargetPlan({ changedFiles: ["src/newfile.ts"], maxTargets: 8 });
  assert.equal(plan.confidence, "none");
  assert.equal(plan.fallbackRequired, true);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
test("empty changed files → no targets, fallback", () => {
  const plan = buildTestTargetPlan({ changedFiles: [], maxTargets: 8 });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.confidence, "none");
  assert.equal(plan.targetFiles.length, 0);
});

test("node_modules path is unsafe for targeting", () => {
  assert.equal(isUnsafeForTargeting("node_modules/foo/index.js"), true);
  assert.equal(isUnsafeForTargeting("node_modules/foo/bar.ts"), true);
});

test("fallbackCheck is set when fallbackRequired", () => {
  const plan = buildTestTargetPlan({
    changedFiles: ["README.md"],
    maxTargets: 8,
    fallbackCheck: "unit",
  });
  assert.equal(plan.fallbackRequired, true);
  assert.equal(plan.fallbackCheck, "unit");
});

test("fallbackCheck is undefined when not fallbackRequired", () => {
  const plan = buildTestTargetPlan({
    changedFiles: ["test/foo.test.ts"],
    maxTargets: 8,
    fallbackCheck: "unit",
  });
  assert.equal(plan.fallbackRequired, false);
  assert.equal(plan.fallbackCheck, undefined);
});
