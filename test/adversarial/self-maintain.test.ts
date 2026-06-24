/**
 * Adversarial tests for the pure self-maintenance orchestrator (selfMaintain.ts).
 *
 * Every side effect is injected via seams — no live model, no git, no `gh`.
 * The merge gate is non-negotiable: a non-applyable PR is NEVER merged.
 *
 * [SWEEP-1]  Full sweep, all green: 2 HIGH + 1 MED → 3 delegateAuto → 3 PRs → merge → all merged
 * [SWEEP-2]  Finding can't be fixed: one worker not applyable → no PR → merge proceeds for others
 * [SWEEP-3]  Merge blocked by gate: applyable at fix, re-gate fails at merge → not merged
 * [SWEEP-4]  --no-fix: stops after triage, no delegateAuto, no delegateMerge
 * [SWEEP-5]  --no-merge: stops after fix, PRs open, merge not called
 * [SWEEP-6]  --dry-run: no side effects, reports what WOULD happen
 * [SWEEP-7]  Restart idempotency: ledger has 2 already-fixed → only 1 new attempted
 * [SWEEP-8]  Adversarial: CRITICAL severity → triage rejects, no task generated
 * [SWEEP-9]  Adversarial: finding with forbidden scope → out_of_scope gate → no PR → attempted
 * [SWEEP-10] Empty findings → report empty, exit clean (no error)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// [SWEEP] red anchor: runSelfMaintain does not exist yet.
import { runSelfMaintain } from "../../src/delegate/selfMaintain.js";
import type {
  AuditFinding,
  SweepState,
  DelegateAutoSeamResult,
  DelegateMergeSeamResult,
} from "../../src/delegate/selfMaintain.js";

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function finding(
  filePath: string,
  severity: string,
  claim: string,
): AuditFinding {
  return { filePath, severity, claim } as AuditFinding;
}

function autoOk(prNumber: number): DelegateAutoSeamResult {
  return { exitCode: 0, prNumber, prUrl: `https://github.com/org/repo/pull/${prNumber}` };
}

function autoFail(reason: string): DelegateAutoSeamResult {
  return { exitCode: 1, prNumber: null, reason };
}

function mergeOk(pr: number): DelegateMergeSeamResult {
  return { pr, outcome: "merged" };
}

function mergeBlocked(pr: number, failingGates: string[]): DelegateMergeSeamResult {
  return { pr, outcome: "skipped-not-applyable", failingGates };
}

/* ------------------------------------------------------------------ */
/*  [SWEEP-1] Full sweep, all green                                    */
/* ------------------------------------------------------------------ */

test("[SWEEP-1] full sweep all green: 2 HIGH + 1 MED → 3 auto → 3 PRs → merge → all merged", async () => {
  const findings: AuditFinding[] = [
    finding("src/foo.ts:42", "HIGH", "null-pointer deref"),
    finding("src/bar.ts:88", "HIGH", "fail-open when bwrap missing"),
    finding("src/baz.ts:17", "MED", "unhandled promise rejection"),
  ];

  const autoCalls: string[] = [];
  const mergePrs: number[] = [];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (task: string): Promise<DelegateAutoSeamResult> => {
      autoCalls.push(task);
      // Return PR numbers 10, 11, 12 in order
      const pr = 10 + autoCalls.length - 1;
      return autoOk(pr);
    },
    delegateMerge: async (prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      mergePrs.push(...prs);
      return prs.map((pr) => mergeOk(pr));
    },
  };

  const report = await runSelfMaintain({}, seams);

  assert.equal(autoCalls.length, 3, "delegateAuto called 3 times");
  assert.equal(mergePrs.length, 3, "delegateMerge called with 3 PRs");
  assert.deepEqual(mergePrs, [10, 11, 12]);

  assert.equal(report.findingsFound, 3);
  assert.equal(report.tasksCreated, 3);
  assert.equal(report.prsOpened, 3);
  assert.equal(report.prsMerged, 3);
  assert.equal(report.skipped.length, 0);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-2] Finding can't be fixed                                   */
/* ------------------------------------------------------------------ */

test("[SWEEP-2] one finding not fixable → no PR for it, merge proceeds for the other 2", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "issue A"),
    finding("src/b.ts:1", "HIGH", "issue B"),
    finding("src/c.ts:1", "MED", "issue C"),
  ];

  let callIdx = 0;
  const mergePrs: number[] = [];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (_task: string): Promise<DelegateAutoSeamResult> => {
      callIdx++;
      if (callIdx === 2) {
        // Finding B cannot be fixed
        return autoFail("worker could not go green");
      }
      return autoOk(callIdx === 1 ? 10 : 12);
    },
    delegateMerge: async (prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      mergePrs.push(...prs);
      return prs.map((pr) => mergeOk(pr));
    },
  };

  const report = await runSelfMaintain({}, seams);

  assert.equal(callIdx, 3, "delegateAuto called 3 times");
  assert.deepEqual(mergePrs, [10, 12], "merge called only for the 2 applyable PRs");
  assert.equal(report.findingsFound, 3);
  assert.equal(report.tasksCreated, 3);
  assert.equal(report.prsOpened, 2);
  assert.equal(report.prsMerged, 2);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].finding.filePath, "src/b.ts:1");
  assert.equal(report.skipped[0].reason, "worker could not go green");
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-3] Merge blocked by gate                                    */
/* ------------------------------------------------------------------ */

test("[SWEEP-3] merge blocked by gate: applyable at fix, re-gate fails at merge → not merged", async () => {
  const findings: AuditFinding[] = [
    finding("src/x.ts:1", "HIGH", "security issue"),
  ];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (_task: string): Promise<DelegateAutoSeamResult> => {
      return autoOk(42);
    },
    delegateMerge: async (prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      return [mergeBlocked(42, ["check_test_phase_failure"])];
    },
  };

  const report = await runSelfMaintain({}, seams);

  assert.equal(report.prsOpened, 1, "PR was opened (applyable at fix time)");
  assert.equal(report.prsMerged, 0, "PR was NOT merged (gate blocked at merge time)");
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].finding.filePath, "src/x.ts:1");
  assert.ok(report.skipped[0].reason.includes("check_test_phase_failure"));
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-4] --no-fix                                                 */
/* ------------------------------------------------------------------ */

test("[SWEEP-4] --no-fix stops after triage, no delegateAuto, no delegateMerge", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "issue"),
  ];

  let autoCalled = false;
  let mergeCalled = false;

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (): Promise<DelegateAutoSeamResult> => {
      autoCalled = true;
      return autoOk(1);
    },
    delegateMerge: async (): Promise<DelegateMergeSeamResult[]> => {
      mergeCalled = true;
      return [];
    },
  };

  const report = await runSelfMaintain({ noFix: true }, seams);

  assert.equal(autoCalled, false, "delegateAuto never called");
  assert.equal(mergeCalled, false, "delegateMerge never called");
  assert.equal(report.findingsFound, 1);
  assert.equal(report.tasksCreated, 1);
  assert.equal(report.prsOpened, 0);
  assert.equal(report.prsMerged, 0);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-5] --no-merge                                               */
/* ------------------------------------------------------------------ */

test("[SWEEP-5] --no-merge stops after fix, PRs open, merge not called", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "issue"),
  ];

  let mergeCalled = false;

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (): Promise<DelegateAutoSeamResult> => {
      return autoOk(7);
    },
    delegateMerge: async (): Promise<DelegateMergeSeamResult[]> => {
      mergeCalled = true;
      return [];
    },
  };

  const report = await runSelfMaintain({ noMerge: true }, seams);

  assert.equal(mergeCalled, false, "delegateMerge never called");
  assert.equal(report.prsOpened, 1);
  assert.equal(report.prsMerged, 0);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-6] --dry-run                                                */
/* ------------------------------------------------------------------ */

test("[SWEEP-6] --dry-run: no side effects, reports what WOULD happen", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "issue A"),
    finding("src/b.ts:1", "MED", "issue B"),
  ];

  let autoCalled = 0;
  let mergeCalled = false;

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (): Promise<DelegateAutoSeamResult> => {
      autoCalled++;
      return autoOk(100 + autoCalled);
    },
    delegateMerge: async (): Promise<DelegateMergeSeamResult[]> => {
      mergeCalled = true;
      return [];
    },
  };

  const report = await runSelfMaintain({ dryRun: true }, seams);

  assert.equal(autoCalled, 0, "delegateAuto NOT called in dry-run");
  assert.equal(mergeCalled, false, "delegateMerge NOT called in dry-run");
  assert.equal(report.findingsFound, 2);
  assert.equal(report.tasksCreated, 2);
  assert.equal(report.prsOpened, 0);
  assert.equal(report.prsMerged, 0);
  assert.equal(report.dryRun, true);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-7] Restart idempotency                                      */
/* ------------------------------------------------------------------ */

test("[SWEEP-7] ledger has 2 already-fixed → only 1 new finding attempted", async () => {
  const ledger: SweepState = {
    lastSweep: "2026-07-15T08:00:00Z",
    findings: {
      "src/a.ts:1": { severity: "HIGH", claim: "issue A", status: "fixed", pr: 5 },
      "src/b.ts:1": { severity: "HIGH", claim: "issue B", status: "attempted", pr: null, reason: "worker failed" },
    },
  };

  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "issue A"),
    finding("src/b.ts:1", "HIGH", "issue B"),
    finding("src/c.ts:1", "MED", "issue C"), // new, not in ledger
  ];

  const autoCalls: string[] = [];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (task: string): Promise<DelegateAutoSeamResult> => {
      autoCalls.push(task);
      return autoOk(20);
    },
    delegateMerge: async (prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      return prs.map((pr) => mergeOk(pr));
    },
  };

  const report = await runSelfMaintain({ ledger }, seams);

  assert.equal(autoCalls.length, 1, "only the NEW finding attempted");
  assert.ok(autoCalls[0].includes("src/c.ts:1"), "task targets the new finding");
  assert.equal(report.tasksCreated, 1);
  assert.equal(report.findingsFound, 3);
  assert.equal(report.prsOpened, 1);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-8] CRITICAL severity rejected by triage                     */
/* ------------------------------------------------------------------ */

test("[SWEEP-8] CRITICAL severity → triage rejects, no task generated", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "valid high"),
    finding("src/x.ts:99", "CRITICAL", "invalid critical"),
  ];

  const autoCalls: string[] = [];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (task: string): Promise<DelegateAutoSeamResult> => {
      autoCalls.push(task);
      return autoOk(1);
    },
    delegateMerge: async (prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      return prs.map((pr) => mergeOk(pr));
    },
  };

  const report = await runSelfMaintain({}, seams);

  // Only the HIGH finding should be a task; CRITICAL is rejected
  assert.equal(report.tasksCreated, 1);
  assert.equal(autoCalls.length, 1);
  assert.ok(autoCalls[0].includes("src/a.ts:1"), "only the HIGH finding fixed");
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].finding.filePath, "src/x.ts:99");
  assert.ok(report.skipped[0].reason.includes("CRITICAL"));
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-9] Forbidden scope → no PR → attempted                      */
/* ------------------------------------------------------------------ */

test("[SWEEP-9] finding fix touches forbidden path → no PR → ledger attempted", async () => {
  const findings: AuditFinding[] = [
    finding("src/secret.ts:1", "HIGH", "secret leak"),
  ];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (_task: string): Promise<DelegateAutoSeamResult> => {
      // Simulates out_of_scope gate catching a forbidden path
      return autoFail("out_of_scope: path src/secret.ts is forbidden");
    },
    delegateMerge: async (_prs: number[]): Promise<DelegateMergeSeamResult[]> => {
      return [];
    },
  };

  const report = await runSelfMaintain({}, seams);

  assert.equal(report.prsOpened, 0, "no PR for out_of_scope finding");
  assert.equal(report.prsMerged, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].finding.filePath, "src/secret.ts:1");
  assert.ok(report.skipped[0].reason.includes("out_of_scope"));
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-10] Empty findings → exit clean, no error                   */
/* ------------------------------------------------------------------ */

test("[SWEEP-10] empty findings → report empty, no errors", async () => {
  let autoCalled = false;
  let mergeCalled = false;

  const seams = {
    runAudit: async () => [] as AuditFinding[],
    delegateAuto: async (): Promise<DelegateAutoSeamResult> => {
      autoCalled = true;
      return autoOk(1);
    },
    delegateMerge: async (): Promise<DelegateMergeSeamResult[]> => {
      mergeCalled = true;
      return [];
    },
  };

  const report = await runSelfMaintain({}, seams);

  assert.equal(autoCalled, false);
  assert.equal(mergeCalled, false);
  assert.equal(report.findingsFound, 0);
  assert.equal(report.tasksCreated, 0);
  assert.equal(report.prsOpened, 0);
  assert.equal(report.prsMerged, 0);
});

/* ------------------------------------------------------------------ */
/*  [SWEEP-11] LOW findings not auto-fixed                              */
/* ------------------------------------------------------------------ */

test("[SWEEP-11] LOW findings are recorded but not auto-fixed", async () => {
  const findings: AuditFinding[] = [
    finding("src/a.ts:1", "HIGH", "serious"),
    finding("src/b.ts:1", "LOW", "cosmetic"),
    finding("src/c.ts:1", "MED", "moderate"),
  ];

  const autoCalls: string[] = [];

  const seams = {
    runAudit: async () => findings,
    delegateAuto: async (task: string) => {
      autoCalls.push(task);
      return autoOk(autoCalls.length);
    },
    delegateMerge: async (prs: number[]) => {
      return prs.map((pr) => mergeOk(pr));
    },
  };

  const report = await runSelfMaintain({}, seams);

  // LOW not auto-fixed
  assert.equal(autoCalls.length, 2, "only HIGH and MED auto-fixed, not LOW");
  assert.equal(report.tasksCreated, 2);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].finding.filePath, "src/b.ts:1");
  assert.ok(report.skipped[0].reason.includes("LOW"));
});
