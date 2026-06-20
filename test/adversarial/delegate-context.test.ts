/**
 * Phase 9E — Adversarial tests for context-aware delegation.
 *
 * These tests inject a FAKE explore function — NO live model is used.
 * They verify:
 *   1. buildContextAwarePlan sets plan.contextBrief (non-empty) and every
 *      worker prompt contains the "## Context brief" heading.
 *   2. The attached brief is BOUNDED: plan.contextBrief.length <= maxBriefBytes.
 *   3. NO raw leakage: only rendered content appears in prompts/plan.contextBrief.
 *   4. FALLBACK on explorer throw → deterministic plan, no contextBrief, no heading.
 *   5. FALLBACK on empty brief → deterministic plan, no contextBrief, no heading.
 *   6. Round-trip persistence: after savePlan + loadPlan, contextBrief survives.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildContextAwarePlan } from "../../src/delegate/contextPlan.js";
import type { ContextAwarePlanOptions } from "../../src/delegate/contextPlan.js";
import { savePlan, loadPlan } from "../../src/delegate/store.js";
import type { ExplorerBrief } from "../../src/context/explorerBrief.js";
import { renderExplorerBrief } from "../../src/context/explorerBrief.js";
import type { DelegationPlan } from "../../src/delegate/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** A fake explore function that returns a non-empty brief. */
function fakeExploreWithBrief(brief: ExplorerBrief): ContextAwarePlanOptions["explore"] {
  return async () => ({ brief });
}

/** A fake explore function that always throws. */
const fakeExploreThatThrows: ContextAwarePlanOptions["explore"] = async () => {
  throw new Error("explorer failure");
};

/** A fake explore function that returns an empty brief. */
const fakeExploreEmptyBrief: ContextAwarePlanOptions["explore"] = async () => ({
  brief: {
    summary: "",
    relevantFiles: [],
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
    trace: [],
  },
});

/** A non-empty brief for testing. */
function sampleBrief(): ExplorerBrief {
  return {
    summary: "The auth module has a null-pointer bug in loginUser.",
    relevantFiles: [
      { path: "src/auth/login.ts", reason: "Contains loginUser function", citations: ["src/auth/login.ts:42"] },
      { path: "src/auth/session.ts", reason: "Session management", citations: ["src/auth/session.ts:10"] },
    ],
    likelyFixLocations: [
      { path: "src/auth/login.ts", confidence: "high", reason: "Missing null check on user input", citations: ["src/auth/login.ts:42"] },
    ],
    relevantTests: [
      { pathOrCommand: "test/auth/login.test.ts", reason: "Login flow tests" },
    ],
    risks: ["Changing login.ts may affect session timeout"],
    openQuestions: ["Is there a rate limiter on login?"],
    trace: [
      { toolsCalled: ["read_file", "grep"], turns: 3, model: "gpt-4o" },
    ],
  };
}

/** A brief with a raw marker that renderExplorerBrief should NOT include. */
function briefWithRawMarker(): ExplorerBrief {
  return {
    summary: "Normal summary",
    relevantFiles: [
      { path: "src/file.ts", reason: "test", citations: ["src/file.ts:1"] },
    ],
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
    // The trace field contains raw tool output that renderExplorerBrief
    // renders as a bounded summary — the raw "trace" object itself is never
    // dumped verbatim. We add a marker that should NOT appear in rendered output.
    trace: [
      { toolsCalled: ["LEAK_RAW_MARKER_should_not_appear"], turns: 99, model: "leak-model" },
    ],
  };
}

/** An oversized brief to test bounding. */
function oversizedBrief(): ExplorerBrief {
  const longSummary = "A".repeat(5000);
  const manyFiles: ExplorerBrief["relevantFiles"] = [];
  for (let i = 0; i < 100; i++) {
    manyFiles.push({
      path: `src/file${i}.ts`,
      reason: "R".repeat(200),
      citations: [`src/file${i}.ts:1`],
    });
  }
  return {
    summary: longSummary,
    relevantFiles: manyFiles,
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
    trace: [],
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "delegate-context-test-"));
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("buildContextAwarePlan", () => {
  const task = "Fix the login bug in the auth module";

  /* ---- Test 1: Non-empty brief sets contextBrief and adds heading ---- */

  test("sets plan.contextBrief and adds ## Context brief to every worker prompt", async () => {
    const plan = await buildContextAwarePlan(task, {
      explore: fakeExploreWithBrief(sampleBrief()),
    });

    assert.ok(plan.contextBrief, "contextBrief should be set");
    assert.ok(plan.contextBrief.length > 0, "contextBrief should be non-empty");

    // Every worker prompt should contain the heading.
    for (const w of plan.workers) {
      assert.ok(
        w.prompt.includes("## Context brief"),
        `Worker ${w.id} prompt should contain "## Context brief" heading`,
      );
    }
  });

  /* ---- Test 2: Bounding — plan.contextBrief.length <= maxBriefBytes ---- */

  test("attached brief is bounded to maxBriefBytes", async () => {
    const maxBriefBytes = 500;
    const plan = await buildContextAwarePlan(task, {
      explore: fakeExploreWithBrief(oversizedBrief()),
      maxBriefBytes,
    });

    assert.ok(plan.contextBrief, "contextBrief should be set");
    assert.ok(
      plan.contextBrief.length <= maxBriefBytes,
      `contextBrief length (${plan.contextBrief.length}) should be <= maxBriefBytes (${maxBriefBytes})`,
    );
  });

  /* ---- Test 3: Only rendered content appears (no raw object dump) ---- */

  test("only rendered content appears in contextBrief and worker prompts", async () => {
    const plan = await buildContextAwarePlan(task, {
      explore: fakeExploreWithBrief(briefWithRawMarker()),
    });

    assert.ok(plan.contextBrief, "contextBrief should be set");

    // The trace is rendered as a bounded summary line, not dumped verbatim.
    // Verify the rendered format: "Trace (1):\n  - model=..."
    assert.ok(
      plan.contextBrief.includes("Trace (1):"),
      "contextBrief should contain the rendered trace heading",
    );
    assert.ok(
      plan.contextBrief.includes("model=leak-model"),
      "contextBrief should contain the rendered trace model info",
    );

    for (const w of plan.workers) {
      assert.ok(
        w.prompt.includes("## Context brief"),
        `Worker ${w.id} prompt should contain "## Context brief" heading`,
      );
    }

    // Strongest leakage guard, internals-agnostic: the brief stored on the plan
    // and the section appended to each prompt are EXACTLY renderExplorerBrief's
    // bounded/redacted output and nothing more — so the raw brief/trace object
    // (anything renderExplorerBrief drops) can never leak into a worker prompt.
    const expected = renderExplorerBrief(briefWithRawMarker(), 6000).slice(0, 6000);
    assert.equal(plan.contextBrief, expected, "contextBrief must be exactly the rendered brief");
    for (const w of plan.workers) {
      assert.ok(
        w.prompt.endsWith(`\n\n## Context brief\n${expected}`),
        `Worker ${w.id} prompt must append only the rendered brief`,
      );
    }
  });

  /* ---- Test 4: Fallback on explorer throw ---- */

  test("fallback when explorer throws — no contextBrief, no heading", async () => {
    const plan = await buildContextAwarePlan(task, {
      explore: fakeExploreThatThrows,
    });

    assert.equal(plan.contextBrief, undefined, "contextBrief should be undefined on explorer failure");

    // No worker prompt should have the heading.
    for (const w of plan.workers) {
      assert.ok(
        !w.prompt.includes("## Context brief"),
        `Worker ${w.id} prompt should NOT contain "## Context brief" heading on explorer failure`,
      );
    }
  });

  /* ---- Test 5: Fallback on empty brief ---- */

  test("fallback when explorer returns empty brief — no contextBrief, no heading", async () => {
    const plan = await buildContextAwarePlan(task, {
      explore: fakeExploreEmptyBrief,
    });

    assert.equal(plan.contextBrief, undefined, "contextBrief should be undefined for empty brief");

    for (const w of plan.workers) {
      assert.ok(
        !w.prompt.includes("## Context brief"),
        `Worker ${w.id} prompt should NOT contain "## Context brief" heading for empty brief`,
      );
    }
  });

  /* ---- Test 6: Round-trip persistence ---- */

  test("contextBrief persists through savePlan + loadPlan", async () => {
    const root = tempRoot();
    try {
      const plan = await buildContextAwarePlan(task, {
        explore: fakeExploreWithBrief(sampleBrief()),
      });

      assert.ok(plan.contextBrief, "contextBrief should be set before save");

      await savePlan(root, plan);
      const loaded = await loadPlan(root, plan.id);

      assert.ok(loaded, "plan should load successfully");
      assert.equal(loaded!.contextBrief, plan.contextBrief, "contextBrief should survive round-trip");
      assert.ok(loaded!.contextBrief!.length > 0, "loaded contextBrief should be non-empty");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /* ---- Additional: Deterministic plan is unchanged when no explore is given ---- */

  test("without explore option, falls back to default (no contextBrief)", async () => {
    // Without an explore option, the default tries to import runExplorer
    // which will fail in test (no provider), so it should fall back gracefully.
    const plan = await buildContextAwarePlan(task, { checkNames: ["typecheck"] });

    // Should still produce a valid plan.
    assert.ok(plan.id, "plan should have an id");
    assert.ok(plan.workers.length >= 1, "plan should have at least one worker");
    // contextBrief should be undefined since the default explore will fail.
    assert.equal(plan.contextBrief, undefined, "contextBrief should be undefined when default explore fails");
  });
});
