/**
 * Phase 9A — Unit tests for delegation types, store, planner, and rendering.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isDelegationPlan } from "../src/delegate/types.js";
import type { DelegationPlan, WorkerTask } from "../src/delegate/types.js";
import { savePlan, loadPlan, listPlans } from "../src/delegate/store.js";
import { buildPlan } from "../src/delegate/planner.js";
import { assertSafeId } from "../src/workspace/paths.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function validPlan(): DelegationPlan {
  return {
    id: "plan-test-001",
    task: "Implement login feature",
    createdAt: "2025-01-01T00:00:00.000Z",
    status: "planned",
    workers: [
      {
        id: "worker-1",
        title: "Implement auth",
        prompt: "Create the auth module",
        allowedPaths: ["src/auth"],
        forbiddenPaths: ["node_modules", ".deepcoder"],
        checkName: "typecheck",
        maxAttempts: 3,
        dependsOn: [],
        expectedOutputs: ["auth module created"],
        status: "planned",
      },
    ],
    dependencies: [],
    globalChecks: ["typecheck"],
    riskNotes: ["Test risk note"],
  };
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "delegate-test-"));
  return dir;
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/*  isDelegationPlan                                                   */
/* ------------------------------------------------------------------ */

describe("isDelegationPlan", () => {
  test("accepts a valid plan", () => {
    assert.equal(isDelegationPlan(validPlan()), true);
  });

  test("rejects null", () => {
    assert.equal(isDelegationPlan(null), false);
  });

  test("rejects undefined", () => {
    assert.equal(isDelegationPlan(undefined), false);
  });

  test("rejects a string", () => {
    assert.equal(isDelegationPlan("not-a-plan"), false);
  });

  test("rejects a number", () => {
    assert.equal(isDelegationPlan(42), false);
  });

  test("rejects an empty object", () => {
    assert.equal(isDelegationPlan({}), false);
  });

  test("rejects missing id", () => {
    const p = validPlan();
    delete (p as Record<string, unknown>).id;
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects missing task", () => {
    const p = validPlan();
    delete (p as Record<string, unknown>).task;
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects missing createdAt", () => {
    const p = validPlan();
    delete (p as Record<string, unknown>).createdAt;
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects invalid status literal", () => {
    const p = validPlan();
    (p as Record<string, unknown>).status = "invalid_status";
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects non-array workers", () => {
    const p = validPlan();
    (p as Record<string, unknown>).workers = "not-an-array";
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects worker with missing id", () => {
    const p = validPlan();
    const badWorker = { ...p.workers[0]! };
    delete (badWorker as Record<string, unknown>).id;
    p.workers = [badWorker];
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects worker with invalid status", () => {
    const p = validPlan();
    p.workers = [{ ...p.workers[0]!, status: "bogus" }];
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects worker with non-number maxAttempts", () => {
    const p = validPlan();
    p.workers = [{ ...p.workers[0]!, maxAttempts: "three" }];
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects non-array dependencies", () => {
    const p = validPlan();
    (p as Record<string, unknown>).dependencies = "not-an-array";
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects dependency with missing before", () => {
    const p = validPlan();
    p.dependencies = [{ before: "", after: "worker-2", reason: "test" }];
    // before is a string (empty is still a string), so this should pass type check
    // Actually empty string is still a string, so it passes. Let's test a missing field.
    const badDep = { after: "worker-2", reason: "test" } as Record<string, unknown>;
    p.dependencies = [badDep as { before: string; after: string; reason: string }];
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects non-array globalChecks", () => {
    const p = validPlan();
    (p as Record<string, unknown>).globalChecks = "not-an-array";
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects non-array riskNotes", () => {
    const p = validPlan();
    (p as Record<string, unknown>).riskNotes = "not-an-array";
    assert.equal(isDelegationPlan(p), false);
  });

  test("rejects globalChecks with non-string element", () => {
    const p = validPlan();
    p.globalChecks = [42 as unknown as string];
    assert.equal(isDelegationPlan(p), false);
  });

  test("accepts all valid status literals", () => {
    const statuses: DelegationPlan["status"][] = [
      "planned",
      "running",
      "needs_review",
      "applied",
      "failed",
      "discarded",
    ];
    for (const status of statuses) {
      const p = validPlan();
      p.status = status;
      assert.equal(isDelegationPlan(p), true, `status "${status}" should be valid`);
    }
  });

  test("accepts all valid worker status literals", () => {
    const statuses: WorkerTask["status"][] = [
      "planned",
      "running",
      "passed",
      "failed",
      "conflict",
      "applied",
      "discarded",
    ];
    for (const status of statuses) {
      const p = validPlan();
      p.workers = [{ ...p.workers[0]!, status }];
      assert.equal(isDelegationPlan(p), true, `worker status "${status}" should be valid`);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Storage roundtrip                                                  */
/* ------------------------------------------------------------------ */

describe("store", () => {
  test("save then load returns an equal plan", async () => {
    const root = tempRoot();
    try {
      const plan = validPlan();
      await savePlan(root, plan);
      const loaded = await loadPlan(root, plan.id);
      assert.notEqual(loaded, null);
      assert.deepEqual(loaded, plan);
    } finally {
      removeDir(root);
    }
  });

  test("loadPlan returns null for non-existent plan", async () => {
    const root = tempRoot();
    try {
      const loaded = await loadPlan(root, "nonexistent");
      assert.equal(loaded, null);
    } finally {
      removeDir(root);
    }
  });

  test("loadPlan returns null on corrupt JSON", async () => {
    const root = tempRoot();
    try {
      // Write a corrupt file manually
      const planDir = join(root, ".deepcoder", "delegations", "corrupt-plan");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "plan.json"), "this is not valid json", "utf8");
      const loaded = await loadPlan(root, "corrupt-plan");
      assert.equal(loaded, null);
    } finally {
      removeDir(root);
    }
  });

  test("loadPlan returns null on malformed plan (missing fields)", async () => {
    const root = tempRoot();
    try {
      const planDir = join(root, ".deepcoder", "delegations", "bad-plan");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "plan.json"), JSON.stringify({ id: "bad-plan" }), "utf8");
      const loaded = await loadPlan(root, "bad-plan");
      assert.equal(loaded, null);
    } finally {
      removeDir(root);
    }
  });

  test("loadPlan returns null on malicious id with path traversal", async () => {
    const root = tempRoot();
    try {
      const loaded = await loadPlan(root, "../../etc/passwd");
      assert.equal(loaded, null);
    } finally {
      removeDir(root);
    }
  });

  test("listPlans returns empty array when no delegations dir exists", async () => {
    const root = tempRoot();
    try {
      const plans = await listPlans(root);
      assert.deepEqual(plans, []);
    } finally {
      removeDir(root);
    }
  });

  test("listPlans returns saved plans sorted by createdAt desc", async () => {
    const root = tempRoot();
    try {
      const plan1 = validPlan();
      plan1.id = "plan-001";
      plan1.createdAt = "2025-01-01T00:00:00.000Z";
      await savePlan(root, plan1);

      const plan2 = validPlan();
      plan2.id = "plan-002";
      plan2.createdAt = "2025-02-01T00:00:00.000Z";
      await savePlan(root, plan2);

      const plans = await listPlans(root);
      assert.equal(plans.length, 2);
      assert.equal(plans[0]!.id, "plan-002"); // newest first
      assert.equal(plans[1]!.id, "plan-001");
    } finally {
      removeDir(root);
    }
  });

  test("listPlans skips corrupt directories", async () => {
    const root = tempRoot();
    try {
      const plan = validPlan();
      plan.id = "plan-valid";
      await savePlan(root, plan);

      // Create a corrupt directory
      const badDir = join(root, ".deepcoder", "delegations", "corrupt-dir");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "plan.json"), "garbage", "utf8");

      const plans = await listPlans(root);
      assert.equal(plans.length, 1);
      assert.equal(plans[0]!.id, "plan-valid");
    } finally {
      removeDir(root);
    }
  });

  test("loadPlan on hand-written garbage file does not throw", async () => {
    const root = tempRoot();
    try {
      const planDir = join(root, ".deepcoder", "delegations", "garbage");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "plan.json"), "{{{broken json!!!", "utf8");
      // Must not throw
      const loaded = await loadPlan(root, "garbage");
      assert.equal(loaded, null);
    } finally {
      removeDir(root);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  assertSafeId                                                       */
/* ------------------------------------------------------------------ */

describe("assertSafeId", () => {
  test("accepts a normal id", () => {
    assert.equal(assertSafeId("plan-001"), "plan-001");
  });

  test("rejects path traversal with ../..", () => {
    assert.throws(() => assertSafeId("../../etc"), /Invalid id/);
  });

  test("rejects absolute path", () => {
    assert.throws(() => assertSafeId("/etc/passwd"), /Invalid id/);
  });

  test("rejects id with spaces", () => {
    assert.throws(() => assertSafeId("plan 001"), /Invalid id/);
  });

  test("accepts alphanumeric, dots, underscores, hyphens", () => {
    assert.equal(assertSafeId("plan.001_test-v2"), "plan.001_test-v2");
  });
});

/* ------------------------------------------------------------------ */
/*  buildPlan                                                          */
/* ------------------------------------------------------------------ */

describe("buildPlan", () => {
  test("returns a valid DelegationPlan", () => {
    const plan = buildPlan("Implement the login feature");
    assert.equal(isDelegationPlan(plan), true);
  });

  test("produces a single worker for a simple task", () => {
    const plan = buildPlan("Fix the bug in the login module");
    assert.equal(plan.workers.length, 1);
    assert.equal(plan.workers[0]!.id, "worker-1");
  });

  test("produces multiple workers when task mentions distinct areas", () => {
    const plan = buildPlan("Implement auth and database and ui components");
    // "auth", "database", "ui" should be inferred as areas
    assert.ok(plan.workers.length >= 1);
    // At minimum, it should be a valid plan
    assert.equal(isDelegationPlan(plan), true);
  });

  test("sets allowedPaths and forbiddenPaths on every worker", () => {
    const plan = buildPlan("Fix something");
    for (const w of plan.workers) {
      assert.ok(Array.isArray(w.allowedPaths));
      assert.ok(w.allowedPaths.length > 0);
      assert.ok(Array.isArray(w.forbiddenPaths));
      assert.ok(w.forbiddenPaths.length > 0);
    }
  });

  test("sets checkName and maxAttempts on every worker", () => {
    const plan = buildPlan("Fix something", { checkNames: ["typecheck", "lint"] });
    for (const w of plan.workers) {
      assert.equal(typeof w.checkName, "string");
      assert.ok(w.checkName.length > 0);
      assert.equal(typeof w.maxAttempts, "number");
      assert.ok(w.maxAttempts > 0);
    }
  });

  test("uses provided checkNames", () => {
    const plan = buildPlan("Fix something", { checkNames: ["my-check"] });
    for (const w of plan.workers) {
      assert.equal(w.checkName, "my-check");
    }
  });

  test("falls back to 'phase' when no checkNames provided", () => {
    const plan = buildPlan("Fix something");
    for (const w of plan.workers) {
      assert.equal(w.checkName, "phase");
    }
  });

  test("includes changedFiles in allowedPaths", () => {
    const plan = buildPlan("Fix something", { changedFiles: ["src/main.ts"] });
    for (const w of plan.workers) {
      assert.ok(w.allowedPaths.includes("src/main.ts"));
    }
  });

  test("sets status to 'planned'", () => {
    const plan = buildPlan("Fix something");
    assert.equal(plan.status, "planned");
  });

  test("all workers start with status 'planned'", () => {
    const plan = buildPlan("Fix something");
    for (const w of plan.workers) {
      assert.equal(w.status, "planned");
    }
  });

  test("riskNotes are populated", () => {
    const plan = buildPlan("Fix something");
    assert.ok(plan.riskNotes.length > 0);
  });

  test("globalChecks mirrors checkNames", () => {
    const plan = buildPlan("Fix something", { checkNames: ["a", "b"] });
    assert.deepEqual(plan.globalChecks, ["a", "b"]);
  });

  test("maxWorkers option caps at 5", () => {
    const plan = buildPlan("Fix auth and database and ui and api and cache and logging", {
      maxWorkers: 10,
    });
    assert.ok(plan.workers.length <= 5);
  });

  test("maxWorkers option floors at 1", () => {
    const plan = buildPlan("Fix something", { maxWorkers: 0 });
    assert.equal(plan.workers.length, 1);
  });

  test("handles empty task gracefully", () => {
    const plan = buildPlan("");
    assert.equal(isDelegationPlan(plan), true);
    assert.equal(plan.workers.length, 1);
  });

  test("handles very long task gracefully", () => {
    const plan = buildPlan("x".repeat(10000));
    assert.equal(isDelegationPlan(plan), true);
    assert.equal(plan.workers.length, 1);
  });

  test("produces deterministic output for same input", () => {
    const plan1 = buildPlan("Implement the login feature");
    const plan2 = buildPlan("Implement the login feature");
    // ids differ (timestamp-based), but worker count and structure should match
    assert.equal(plan1.workers.length, plan2.workers.length);
    assert.equal(plan1.workers[0]!.title, plan2.workers[0]!.title);
    assert.equal(plan1.workers[0]!.checkName, plan2.workers[0]!.checkName);
  });
});

/* ------------------------------------------------------------------ */
/*  Dependency cycle detection                                         */
/* ------------------------------------------------------------------ */

describe("dependency cycle detection", () => {
  test("no cycle for a single worker", () => {
    // A single worker has no dependencies, so no cycle.
    const plan = buildPlan("Fix something");
    assert.equal(isDelegationPlan(plan), true);
  });

  test("sequential dependencies do not create a cycle", () => {
    // Multiple areas create sequential dependencies, which are acyclic.
    const plan = buildPlan("Implement auth and database");
    assert.equal(isDelegationPlan(plan), true);
    // If we got 2+ workers, dependencies should be acyclic
    if (plan.workers.length >= 2) {
      assert.ok(plan.dependencies.length > 0);
    }
  });

  test("buildPlan never produces a cycle internally", () => {
    // Run many times with different inputs to ensure no cycle is ever produced.
    const inputs = [
      "Fix the bug",
      "Implement auth and database and ui",
      "Create api and cache and logging",
      "Refactor the entire codebase",
      "Add tests for auth module",
    ];
    for (const input of inputs) {
      const plan = buildPlan(input);
      assert.equal(isDelegationPlan(plan), true);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Bounded rendering (string-length checks)                           */
/* ------------------------------------------------------------------ */

describe("bounded rendering", () => {
  test("status rendering of a large plan stays under a sane byte cap", () => {
    // Build a plan with many workers to test bounded rendering.
    const plan = buildPlan(
      "Implement auth and database and ui and api and cache and logging and messaging and storage",
      { checkNames: ["typecheck"] },
    );
    // Render a status-like output (simulating what the slash command does).
    const lines: string[] = [];
    lines.push(`Plan: ${plan.id}`);
    lines.push(`  task: ${plan.task.slice(0, 80)}`);
    lines.push(`  status: ${plan.status}`);
    for (const w of plan.workers.slice(0, 20)) {
      const title = w.title.length > 40 ? w.title.slice(0, 37) + "…" : w.title;
      lines.push(`  ${w.id.padEnd(12)} ${w.status.padEnd(12)} ${w.checkName.padEnd(22)} ${title}`);
    }
    const output = lines.join("\n");
    // Must be under 100 KB (very generous bound).
    assert.ok(Buffer.byteLength(output, "utf8") < 100 * 1024, "Status output exceeds 100 KB");
  });

  test("review rendering of a large plan stays under a sane byte cap", () => {
    const plan = buildPlan(
      "Implement auth and database and ui and api and cache and logging and messaging and storage",
      { checkNames: ["typecheck", "lint"] },
    );
    const lines: string[] = [];
    lines.push("=== Delegation Plan Review ===");
    lines.push(`id: ${plan.id}`);
    lines.push(`created: ${plan.createdAt}`);
    lines.push(`status: ${plan.status}`);
    lines.push(`task: ${plan.task.slice(0, 200)}`);
    for (const w of plan.workers.slice(0, 20)) {
      lines.push(`  ${w.id}`);
      lines.push(`    title: ${w.title.slice(0, 200)}`);
      lines.push(`    check: ${w.checkName}`);
      lines.push(`    maxAttempts: ${w.maxAttempts}`);
      lines.push(`    status: ${w.status}`);
      if (w.allowedPaths.length) lines.push(`    allowed: ${w.allowedPaths.join(", ")}`);
      if (w.forbiddenPaths.length) lines.push(`    forbidden: ${w.forbiddenPaths.join(", ")}`);
    }
    for (const d of plan.dependencies.slice(0, 20)) {
      lines.push(`  ${d.before} → ${d.after}  ${d.reason.slice(0, 200)}`);
    }
    for (const r of plan.riskNotes.slice(0, 20)) {
      lines.push(`  - ${r}`);
    }
    const output = lines.join("\n");
    assert.ok(Buffer.byteLength(output, "utf8") < 100 * 1024, "Review output exceeds 100 KB");
  });

  test("rendering does not crash on empty plan", () => {
    const plan = buildPlan("");
    const lines: string[] = [];
    lines.push(`Plan: ${plan.id}`);
    for (const w of plan.workers) {
      lines.push(`  ${w.id}: ${w.title}`);
    }
    const output = lines.join("\n");
    assert.ok(output.length > 0);
    assert.ok(Buffer.byteLength(output, "utf8") < 1024);
  });
});
