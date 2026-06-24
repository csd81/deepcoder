/**
 * Adversarial tests for the pure PR merge orchestrator (prMerge.ts).
 *
 * Every side effect is injected via the `deps` seam — no live model, no git,
 * no `gh`. The gate is non-negotiable: a non-applyable PR is NEVER merged,
 * and the gate is re-checked AFTER conflict resolution and immediately before
 * `gh pr merge`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// [MERGE] red anchor: mergePr does not exist yet.
import { mergePr } from "../../src/delegate/prMerge.js";
import type { PrMergeResult } from "../../src/delegate/prMerge.js";

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function gate(applyable: boolean, codes: string[] = []): {
  applyable: boolean;
  failures: { code: string }[];
} {
  return {
    applyable,
    failures: applyable ? [] : codes.map((code) => ({ code })),
  };
}

function noConflicts(): string[] {
  return [];
}

function conflicts(...files: string[]): string[] {
  return files;
}

function resolved(): string[] {
  return [];
}

function stillConflicted(...files: string[]): string[] {
  return files;
}

/* ------------------------------------------------------------------ */
/*  [MERGE-1] gate blocks merge                                        */
/* ------------------------------------------------------------------ */

test("[MERGE-1] non-applyable PR → skipped-not-applyable, merge NOT called", async () => {
  let mergeCalled = 0;
  const result = await mergePr(42, {
    validate: async () => gate(false, ["check_failed"]),
    conflicts: async () => noConflicts(),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 0, "merge must never be called");
  assert.equal(result.outcome, "skipped-not-applyable");
  assert.deepEqual(result.failingGates, ["check_failed"]);
  assert.equal(result.unresolvedFiles, undefined);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-2] clean + applyable → merged                               */
/* ------------------------------------------------------------------ */

test("[MERGE-2] applyable + no conflicts → merged, merge called exactly once", async () => {
  let mergeCalled = 0;
  const result = await mergePr(7, {
    validate: async () => gate(true),
    conflicts: async () => noConflicts(),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 1, "merge called exactly once");
  assert.equal(result.outcome, "merged");
  assert.equal(result.failingGates, undefined);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-3] conflicts → resolve → re-gate → merge                    */
/* ------------------------------------------------------------------ */

test("[MERGE-3] conflicts resolved → re-gate passes → resolved-and-merged", async () => {
  const calls: string[] = [];
  let mergeCalled = 0;

  const result = await mergePr(3, {
    validate: async () => {
      calls.push("validate");
      return gate(true);
    },
    conflicts: async () => {
      calls.push("conflicts");
      return conflicts("src/a.ts", "src/b.ts");
    },
    resolve: async (files: string[]) => {
      calls.push(`resolve(${files.join(",")})`);
      return resolved();
    },
    merge: async () => {
      calls.push("merge");
      mergeCalled++;
    },
  });

  assert.equal(mergeCalled, 1, "merge called after resolution");
  assert.equal(result.outcome, "resolved-and-merged");
  assert.equal(result.unresolvedFiles, undefined);
  // Verify ordering: validate → conflicts → resolve → re-validate → merge
  assert.deepEqual(calls, [
    "validate",
    "conflicts",
    "resolve(src/a.ts,src/b.ts)",
    "validate",
    "merge",
  ]);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-4] unresolved conflicts → no merge                          */
/* ------------------------------------------------------------------ */

test("[MERGE-4] resolve leaves files conflicted → conflicts-unresolved, no merge", async () => {
  let mergeCalled = 0;

  const result = await mergePr(5, {
    validate: async () => gate(true),
    conflicts: async () => conflicts("src/x.ts"),
    resolve: async () => stillConflicted("src/x.ts"),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 0, "merge must NOT be called when conflicts remain");
  assert.equal(result.outcome, "conflicts-unresolved");
  assert.deepEqual(result.unresolvedFiles, ["src/x.ts"]);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-5] resolution regresses the gate → no merge                 */
/* ------------------------------------------------------------------ */

test("[MERGE-5] resolution that regresses the gate → skipped-not-applyable, no merge", async () => {
  let validateCount = 0;
  let mergeCalled = 0;

  const result = await mergePr(9, {
    validate: async () => {
      validateCount++;
      // First check passes, re-check after resolution fails
      return validateCount === 1 ? gate(true) : gate(false, ["check_failed"]);
    },
    conflicts: async () => conflicts("src/z.ts"),
    resolve: async () => resolved(),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 0, "merge must NOT be called when re-gate fails");
  assert.equal(result.outcome, "skipped-not-applyable");
  assert.deepEqual(result.failingGates, ["check_failed"]);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-6] --dry-run: reports outcomes, no side effects             */
/* ------------------------------------------------------------------ */

test("[MERGE-6] --dry-run reports outcome, calls neither resolve nor merge", async () => {
  let resolveCalled = false;
  let mergeCalled = false;

  const result = await mergePr(11, {
    validate: async () => gate(true),
    conflicts: async () => conflicts("src/d.ts"),
    resolve: async () => { resolveCalled = true; return resolved(); },
    merge: async () => { mergeCalled = true; },
  }, { dryRun: true });

  assert.equal(resolveCalled, false, "resolve must NOT be called in dry-run");
  assert.equal(mergeCalled, false, "merge must NOT be called in dry-run");
  // In dry-run mode, we still report what WOULD happen. With conflicts present
  // and gate green, a real run would attempt resolve → "resolved-and-merged"
  // if successful. Dry-run reports the intended path.
  assert.equal(result.outcome, "merged");
});

test("[MERGE-6b] --dry-run on non-applyable reports skipped-not-applyable", async () => {
  let mergeCalled = false;

  const result = await mergePr(13, {
    validate: async () => gate(false, ["quality_gate_blocked"]),
    conflicts: async () => noConflicts(),
    merge: async () => { mergeCalled = true; },
  }, { dryRun: true });

  assert.equal(mergeCalled, false);
  assert.equal(result.outcome, "skipped-not-applyable");
  assert.deepEqual(result.failingGates, ["quality_gate_blocked"]);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-7] adversarial TOCTOU: re-check immediately before merge    */
/* ------------------------------------------------------------------ */

test("[MERGE-7] PR becomes non-applyable between check and merge → not merged", async () => {
  let validateCount = 0;
  let mergeCalled = 0;

  // No conflicts path — but the gate flips between the initial check and the
  // pre-merge re-check.
  const result = await mergePr(15, {
    validate: async () => {
      validateCount++;
      return validateCount === 1 ? gate(true) : gate(false, ["check_failed"]);
    },
    conflicts: async () => noConflicts(),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 0, "merge must NOT be called when pre-merge re-check fails");
  assert.equal(result.outcome, "skipped-not-applyable");
  assert.deepEqual(result.failingGates, ["check_failed"]);
  // The pre-merge re-check must have run (validate called twice)
  assert.equal(validateCount, 2, "re-check must run before merge");
});

/* ------------------------------------------------------------------ */
/*  [MERGE-8] no conflicts + no resolve deps → merged directly         */
/* ------------------------------------------------------------------ */

test("[MERGE-8] no conflicts, resolve not provided → merged", async () => {
  let mergeCalled = 0;

  const result = await mergePr(17, {
    validate: async () => gate(true),
    conflicts: async () => noConflicts(),
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 1);
  assert.equal(result.outcome, "merged");
});

/* ------------------------------------------------------------------ */
/*  [MERGE-9] conflicts but no resolve deps → conflicts-unresolved     */
/* ------------------------------------------------------------------ */

test("[MERGE-9] conflicts present, resolve not provided → conflicts-unresolved", async () => {
  let mergeCalled = 0;

  const result = await mergePr(19, {
    validate: async () => gate(true),
    conflicts: async () => conflicts("src/e.ts"),
    // resolve NOT provided
    merge: async () => { mergeCalled++; },
  });

  assert.equal(mergeCalled, 0);
  assert.equal(result.outcome, "conflicts-unresolved");
  assert.deepEqual(result.unresolvedFiles, ["src/e.ts"]);
});

/* ------------------------------------------------------------------ */
/*  [MERGE-10] error handling: validate throws → error                 */
/* ------------------------------------------------------------------ */

test("[MERGE-10] validate throws → error outcome", async () => {
  const result = await mergePr(21, {
    validate: async () => { throw new Error("BOOM"); },
    conflicts: async () => noConflicts(),
    merge: async () => {},
  });

  assert.equal(result.outcome, "error");
  assert.equal(result.failingGates, undefined);
});
