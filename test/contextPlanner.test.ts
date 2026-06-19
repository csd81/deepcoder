import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextPlan, clampPlan } from "../src/context/contextPlan.js";
import type { ContextPlan } from "../src/context/contextPlan.js";
import { buildDeterministicPlan, planContext } from "../src/context/contextPlanner.js";
import type { RepoIndex } from "../src/index/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const emptyIndex: RepoIndex = {
  root: "/fake",
  files: [],
  counts: { code: 0, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
  symbols: [],
  imports: [],
};

const sampleIndex: RepoIndex = {
  root: "/fake",
  files: [
    { path: "src/auth/login.ts", kind: "code", lang: "ts" },
    { path: "src/auth/logout.ts", kind: "code", lang: "ts" },
    { path: "src/db/connection.ts", kind: "code", lang: "ts" },
    { path: "src/db/migrations.ts", kind: "code", lang: "ts" },
    { path: "src/utils/helpers.ts", kind: "code", lang: "ts" },
    { path: "test/auth/login.test.ts", kind: "test", lang: "ts" },
    { path: "README.md", kind: "docs" },
    { path: "tsconfig.json", kind: "config" },
  ],
  counts: { code: 5, test: 1, config: 1, docs: 1, generated: 0, other: 0 },
  symbols: [
    { name: "loginUser", kind: "function", file: "src/auth/login.ts", line: 1 },
    { name: "logoutUser", kind: "function", file: "src/auth/logout.ts", line: 1 },
    { name: "connectDb", kind: "function", file: "src/db/connection.ts", line: 1 },
    { name: "runMigrations", kind: "function", file: "src/db/migrations.ts", line: 1 },
    { name: "formatDate", kind: "function", file: "src/utils/helpers.ts", line: 1 },
  ],
  imports: [],
};

/* ------------------------------------------------------------------ */
/*  isContextPlan                                                      */
/* ------------------------------------------------------------------ */

test("isContextPlan returns true for a valid plan", () => {
  const plan: ContextPlan = {
    taskSummary: "Fix login bug",
    likelyAreas: ["src/auth"],
    initialQueries: ["login"],
    mustRead: ["src/auth/login.ts"],
    likelySymbols: ["loginUser"],
    likelyChecks: ["typecheck"],
    riskNotes: ["Check auth edge cases"],
    stopConditions: ["All files read"],
  };
  assert.equal(isContextPlan(plan), true);
});

test("isContextPlan returns false for null", () => {
  assert.equal(isContextPlan(null), false);
});

test("isContextPlan returns false for a non-object", () => {
  assert.equal(isContextPlan("string"), false);
});

test("isContextPlan returns false when taskSummary is missing", () => {
  assert.equal(isContextPlan({ likelyAreas: [] }), false);
});

test("isContextPlan returns false when an array field is not an array", () => {
  assert.equal(
    isContextPlan({
      taskSummary: "x",
      likelyAreas: "not-an-array",
      initialQueries: [],
      mustRead: [],
      likelySymbols: [],
      likelyChecks: [],
      riskNotes: [],
      stopConditions: [],
    }),
    false,
  );
});

test("isContextPlan returns false when an array field contains non-strings", () => {
  assert.equal(
    isContextPlan({
      taskSummary: "x",
      likelyAreas: [42],
      initialQueries: [],
      mustRead: [],
      likelySymbols: [],
      likelyChecks: [],
      riskNotes: [],
      stopConditions: [],
    }),
    false,
  );
});

/* ------------------------------------------------------------------ */
/*  clampPlan                                                         */
/* ------------------------------------------------------------------ */

test("clampPlan dedupes and bounds lists", () => {
  const plan: ContextPlan = {
    taskSummary: "  fix login  ",
    likelyAreas: ["src/a", "src/a", "src/b", "src/c"],
    initialQueries: [],
    mustRead: [],
    likelySymbols: [],
    likelyChecks: [],
    riskNotes: [],
    stopConditions: [],
  };
  clampPlan(plan, { maxPerList: 2 });
  assert.deepEqual(plan.likelyAreas, ["src/a", "src/b"]);
  assert.equal(plan.taskSummary, "fix login");
});

test("clampPlan drops empty strings", () => {
  const plan: ContextPlan = {
    taskSummary: "test",
    likelyAreas: ["valid", "", "  ", "also-valid"],
    initialQueries: [],
    mustRead: [],
    likelySymbols: [],
    likelyChecks: [],
    riskNotes: [],
    stopConditions: [],
  };
  clampPlan(plan);
  assert.deepEqual(plan.likelyAreas, ["valid", "also-valid"]);
});

test("clampPlan truncates long entries", () => {
  const plan: ContextPlan = {
    taskSummary: "test",
    likelyAreas: ["a".repeat(500)],
    initialQueries: [],
    mustRead: [],
    likelySymbols: [],
    likelyChecks: [],
    riskNotes: [],
    stopConditions: [],
  };
  clampPlan(plan, { maxEntryLength: 10 });
  assert.equal(plan.likelyAreas[0]!.length, 10);
});

/* ------------------------------------------------------------------ */
/*  buildDeterministicPlan                                             */
/* ------------------------------------------------------------------ */

test("buildDeterministicPlan returns a valid ContextPlan", () => {
  const plan = buildDeterministicPlan({
    task: "Fix the login flow in the auth module",
    index: sampleIndex,
    checkNames: ["typecheck", "lint"],
    changedFiles: ["src/auth/login.ts"],
  });
  assert.equal(isContextPlan(plan), true);
  assert.ok(plan.taskSummary.includes("login"));
  assert.ok(plan.likelyAreas.includes("src/auth"));
  assert.ok(plan.mustRead.includes("src/auth/login.ts"));
  assert.ok(plan.likelyChecks.includes("typecheck"));
});

test("buildDeterministicPlan handles empty index gracefully", () => {
  const plan = buildDeterministicPlan({
    task: "Do something",
    index: emptyIndex,
    checkNames: [],
    changedFiles: [],
  });
  assert.equal(isContextPlan(plan), true);
  assert.equal(plan.likelyAreas.length, 0);
  assert.equal(plan.mustRead.length, 0);
  assert.equal(plan.likelySymbols.length, 0);
  assert.equal(plan.likelyChecks.length, 0);
  assert.ok(plan.riskNotes.length > 0);
});

test("buildDeterministicPlan never throws", () => {
  for (const task of ["", "a", "x".repeat(1000), "  ", "修复登录"]) {
    const plan = buildDeterministicPlan({
      task,
      index: emptyIndex,
      checkNames: [],
      changedFiles: [],
    });
    assert.equal(isContextPlan(plan), true);
  }
});

test("buildDeterministicPlan bounds all lists", () => {
  const manyFiles: RepoIndex = {
    root: "/fake",
    files: Array.from({ length: 100 }, (_, i) => ({
      path: `src/mod${i}/file${i}.ts`,
      kind: "code" as const,
      lang: "ts",
    })),
    counts: { code: 100, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
    symbols: Array.from({ length: 100 }, (_, i) => ({
      name: `symbol${i}`,
      kind: "function" as const,
      file: `src/mod${i}/file${i}.ts`,
      line: 1,
    })),
    imports: [],
  };
  const plan = buildDeterministicPlan({
    task: "fix symbol0 and symbol1",
    index: manyFiles,
    checkNames: Array.from({ length: 50 }, (_, i) => `check${i}`),
    changedFiles: Array.from({ length: 50 }, (_, i) => `src/mod${i}/file${i}.ts`),
  });
  assert.ok(plan.likelyAreas.length <= 20);
  assert.ok(plan.initialQueries.length <= 20);
  assert.ok(plan.mustRead.length <= 20);
  assert.ok(plan.likelySymbols.length <= 20);
  assert.ok(plan.likelyChecks.length <= 20);
  assert.ok(plan.riskNotes.length <= 20);
  assert.ok(plan.stopConditions.length <= 20);
});

/* ------------------------------------------------------------------ */
/*  planContext                                                        */
/* ------------------------------------------------------------------ */

test("planContext without modelHook returns deterministic plan", async () => {
  const plan = await planContext({
    task: "Fix login",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
  });
  assert.equal(isContextPlan(plan), true);
  assert.ok(plan.taskSummary.includes("login"));
});

test("planContext with modelHook returning valid JSON uses model plan", async () => {
  const plan = await planContext({
    task: "Fix login",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
    modelHook: async () =>
      JSON.stringify({
        taskSummary: "Model says: fix login",
        likelyAreas: ["src/auth"],
        initialQueries: ["login", "auth"],
        mustRead: ["src/auth/login.ts"],
        likelySymbols: ["loginUser"],
        likelyChecks: ["typecheck"],
        riskNotes: ["Watch for edge cases"],
        stopConditions: ["All done"],
      }),
  });
  assert.equal(isContextPlan(plan), true);
  assert.equal(plan.taskSummary, "Model says: fix login");
  assert.deepEqual(plan.likelyAreas, ["src/auth"]);
});

test("planContext with modelHook returning malformed JSON falls back to deterministic", async () => {
  const plan = await planContext({
    task: "Fix login flow",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
    modelHook: async () => "not valid json at all",
  });
  assert.equal(isContextPlan(plan), true);
  // Should contain deterministic content (login from task)
  assert.ok(plan.taskSummary.includes("login"));
});

test("planContext with modelHook returning empty string falls back to deterministic", async () => {
  const plan = await planContext({
    task: "Fix login flow",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
    modelHook: async () => "",
  });
  assert.equal(isContextPlan(plan), true);
  assert.ok(plan.taskSummary.includes("login"));
});

test("planContext with modelHook returning invalid shape falls back to deterministic", async () => {
  const plan = await planContext({
    task: "Fix login flow",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
    modelHook: async () =>
      JSON.stringify({
        taskSummary: "Model plan",
        // missing all array fields
      }),
  });
  assert.equal(isContextPlan(plan), true);
  assert.ok(plan.taskSummary.includes("login"));
});

test("planContext with modelHook that throws falls back to deterministic", async () => {
  const plan = await planContext({
    task: "Fix login flow",
    index: sampleIndex,
    checkNames: ["typecheck"],
    changedFiles: [],
    modelHook: async () => {
      throw new Error("network error");
    },
  });
  assert.equal(isContextPlan(plan), true);
  assert.ok(plan.taskSummary.includes("login"));
});

test("planContext never throws", async () => {
  for (const hook of [undefined, async () => "", async () => "{{{bad json", async () => "null"]) {
    const plan = await planContext({
      task: "test",
      index: emptyIndex,
      checkNames: [],
      changedFiles: [],
      modelHook: hook as (() => Promise<string>) | undefined,
    });
    assert.equal(isContextPlan(plan), true);
  }
});
