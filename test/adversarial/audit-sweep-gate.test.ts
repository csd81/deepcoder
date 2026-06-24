import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAuditSweep } from "../../src/cli/auditSweepCli.js";
import { loadSweepState, ledgerPath } from "../../src/audit/sweepState.js";
import type {
  AuditFinding,
  DelegateAutoSeamResult,
  DelegateMergeSeamResult,
  SelfMaintainSeams,
} from "../../src/delegate/selfMaintain.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "audit-gate-"));
}

function seams(
  findings: AuditFinding[],
  auto: (task: string) => DelegateAutoSeamResult,
  merge: (prs: number[]) => DelegateMergeSeamResult[],
  spy: { autoCalls: string[]; mergeCalls: number[][] },
): SelfMaintainSeams {
  return {
    runAudit: async () => findings,
    delegateAuto: async (t) => {
      spy.autoCalls.push(t);
      return auto(t);
    },
    delegateMerge: async (prs) => {
      spy.mergeCalls.push(prs);
      return merge(prs);
    },
  };
}

test("adversarial: a CRITICAL (out-of-schema) severity is rejected by triage — never fixed", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const s = seams(
      [{ filePath: "src/x.ts:1", severity: "CRITICAL" as AuditFinding["severity"], claim: "made up" }],
      () => ({ exitCode: 0, prNumber: 1 }),
      (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    );
    const report = await runAuditSweep(root, {}, { seams: s, now: "t" });
    assert.equal(report.tasksCreated, 0, "CRITICAL must not become a task");
    assert.equal(spy.autoCalls.length, 0, "delegateAuto must never run for an invalid severity");
    assert.ok(report.skipped.some((sk) => /invalid severity/i.test(sk.reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adversarial: LOW findings are recorded but never auto-fixed", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const s = seams(
      [{ filePath: "src/low.ts:1", severity: "LOW", claim: "cosmetic" }],
      () => ({ exitCode: 0, prNumber: 1 }),
      (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    );
    const report = await runAuditSweep(root, {}, { seams: s, now: "t" });
    assert.equal(report.tasksCreated, 0);
    assert.equal(spy.autoCalls.length, 0);
    assert.ok(report.skipped.some((sk) => /LOW/i.test(sk.reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adversarial: a non-applyable fix opens no PR and is never merged", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const s = seams(
      [
        { filePath: "src/ok.ts:1", severity: "HIGH", claim: "fixable" },
        { filePath: "src/bad.ts:2", severity: "HIGH", claim: "unfixable" },
      ],
      (task) =>
        /bad\.ts/.test(task)
          ? { exitCode: 1, prNumber: null, reason: "gate failed" }
          : { exitCode: 0, prNumber: 50 },
      (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    );
    const report = await runAuditSweep(root, {}, { seams: s, now: "t" });
    assert.equal(report.prsOpened, 1, "only the applyable fix opens a PR");
    // Merge only ever sees the one opened PR — the non-applyable finding is excluded.
    assert.deepEqual(spy.mergeCalls, [[50]]);
    const ledger = await loadSweepState(root);
    assert.equal(ledger.findings["src/bad.ts:2"].status, "attempted");
    assert.equal(ledger.findings["src/ok.ts:1"].status, "fixed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adversarial: an applyable PR blocked at the merge gate is NOT merged (recorded attempted)", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const s = seams(
      [{ filePath: "src/race.ts:1", severity: "HIGH", claim: "master advanced" }],
      () => ({ exitCode: 0, prNumber: 77 }),
      (prs) => prs.map((p) => ({ pr: p, outcome: "skipped-not-applyable" as const, failingGates: ["mergeable=CONFLICTING"] })),
      spy,
    );
    const report = await runAuditSweep(root, {}, { seams: s, now: "t" });
    assert.equal(report.prsOpened, 1);
    assert.equal(report.prsMerged, 0, "a red merge gate must never merge");
    const ledger = await loadSweepState(root);
    assert.equal(ledger.findings["src/race.ts:1"].status, "attempted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adversarial: --dry-run has no side effects — no delegateAuto/Merge, no ledger written", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const s = seams(
      [{ filePath: "src/a.ts:1", severity: "HIGH", claim: "a" }],
      () => ({ exitCode: 0, prNumber: 1 }),
      (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    );
    const report = await runAuditSweep(root, { dryRun: true }, { seams: s, now: "t" });
    assert.equal(report.dryRun, true);
    assert.equal(report.tasksCreated, 1);
    assert.equal(spy.autoCalls.length, 0, "dry-run must not call delegateAuto");
    assert.equal(spy.mergeCalls.length, 0, "dry-run must not call delegateMerge");
    // No ledger file written.
    const dir = path.dirname(ledgerPath(root));
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      /* dir absent is the expected case */
    }
    assert.ok(!entries.includes(".sweep-state.json"), "dry-run must not persist the ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
