import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAuditFindings, parseFindings } from "../src/audit/findingsParser.js";
import { loadSweepState, saveSweepState, mergeLedger, ledgerPath } from "../src/audit/sweepState.js";
import { runAuditSweep, prNumberFromUrl, defaultSeams } from "../src/cli/auditSweepCli.js";
import type {
  AuditFinding,
  DelegateAutoSeamResult,
  DelegateMergeSeamResult,
  SelfMaintainSeams,
  SweepReport,
  SweepState,
} from "../src/delegate/selfMaintain.js";

const HI = "`src/a.ts:10` · **HIGH** · rule-bypass on empty matcher";
const MED = "`src/b.ts:20` · **MED** · timer not cleared on fast-reject";

/* ---------------------- findings parser ---------------------- */

test("parseFindings extracts path:line · severity · claim", () => {
  const md = `## HIGH\n- ${HI}\n## MED\n- ${MED}\n`;
  const out = parseFindings(md);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { filePath: "src/a.ts:10", severity: "HIGH", claim: "rule-bypass on empty matcher" });
  assert.equal(out[1].filePath, "src/b.ts:20");
});

test("parseFindings ignores prose and non-conforming lines", () => {
  const md = "Some prose line.\n- a bullet with no finding\n`not a finding` here\n";
  assert.equal(parseFindings(md).length, 0);
});

test("parseAuditFindings preserves out-of-schema severities verbatim (for triage to reject)", () => {
  const md = "- `src/x.ts:1` · **CRITICAL** · made-up severity\n";
  const out = parseAuditFindings(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "CRITICAL");
});

/* ---------------------- ledger ---------------------- */

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "audit-sweep-"));
}

test("loadSweepState returns empty ledger when file is missing", async () => {
  const root = await ws();
  try {
    const s = await loadSweepState(root);
    assert.deepEqual(s, { lastSweep: "", findings: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveSweepState writes atomically and round-trips", async () => {
  const root = await ws();
  try {
    const state: SweepState = {
      lastSweep: "2026-07-15T08:00:00Z",
      findings: { "src/a.ts:10": { severity: "HIGH", claim: "x", status: "fixed", pr: 42 } },
    };
    await saveSweepState(root, state);
    const onDisk = JSON.parse(await readFile(ledgerPath(root), "utf8"));
    assert.deepEqual(onDisk, state);
    assert.deepEqual(await loadSweepState(root), state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSweepState tolerates a corrupt ledger (fresh empty)", async () => {
  const root = await ws();
  try {
    await mkdir(path.dirname(ledgerPath(root)), { recursive: true });
    await writeFile(ledgerPath(root), "{ not json", "utf8");
    assert.deepEqual(await loadSweepState(root), { lastSweep: "", findings: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeLedger records merged as fixed, unmerged as attempted, and never downgrades fixed", () => {
  const prev: SweepState = {
    lastSweep: "old",
    findings: { "src/a.ts:10": { severity: "HIGH", claim: "x", status: "fixed", pr: 1 } },
  };
  const report: SweepReport = {
    findingsFound: 2,
    tasksCreated: 2,
    prsOpened: 2,
    prsMerged: 1,
    skipped: [],
    dryRun: false,
    results: [
      // already-fixed finding re-surfaces — must stay fixed, not be overwritten.
      {
        finding: { filePath: "src/a.ts:10", severity: "HIGH", claim: "x" },
        task: "t",
        fixResult: { exitCode: 1, prNumber: null },
        mergeResult: null,
      },
      // new finding merged → fixed.
      {
        finding: { filePath: "src/b.ts:20", severity: "MED", claim: "y" },
        task: "t",
        fixResult: { exitCode: 0, prNumber: 7 },
        mergeResult: { pr: 7, outcome: "merged" },
      },
    ],
  };
  const next = mergeLedger(prev, report, "now");
  assert.equal(next.lastSweep, "now");
  assert.deepEqual(next.findings["src/a.ts:10"], { severity: "HIGH", claim: "x", status: "fixed", pr: 1 });
  assert.equal(next.findings["src/b.ts:20"].status, "fixed");
  assert.equal(next.findings["src/b.ts:20"].pr, 7);
});

test("mergeLedger records a gate-blocked merge as attempted with reason", () => {
  const report: SweepReport = {
    findingsFound: 1,
    tasksCreated: 1,
    prsOpened: 1,
    prsMerged: 0,
    skipped: [],
    dryRun: false,
    results: [
      {
        finding: { filePath: "src/c.ts:5", severity: "HIGH", claim: "z" },
        task: "t",
        fixResult: { exitCode: 0, prNumber: 9 },
        mergeResult: { pr: 9, outcome: "conflicts-unresolved", failingGates: ["conflict"] },
      },
    ],
  };
  const next = mergeLedger({ lastSweep: "", findings: {} }, report, "now");
  assert.equal(next.findings["src/c.ts:5"].status, "attempted");
  assert.match(next.findings["src/c.ts:5"].reason ?? "", /conflicts-unresolved/);
});

/* ---------------------- prNumberFromUrl ---------------------- */

test("prNumberFromUrl parses /pull/N and #N", () => {
  assert.equal(prNumberFromUrl("https://github.com/o/r/pull/342"), 342);
  assert.equal(prNumberFromUrl("#17"), 17);
  assert.equal(prNumberFromUrl(undefined), null);
  assert.equal(prNumberFromUrl("no number here"), null);
});

/* ---------------------- end-to-end sweep (injected seams) ---------------------- */

function seamsFrom(opts: {
  findings: AuditFinding[];
  auto: (task: string) => DelegateAutoSeamResult;
  merge: (prs: number[]) => DelegateMergeSeamResult[];
  spy?: { autoCalls: string[]; mergeCalls: number[][] };
}): SelfMaintainSeams {
  return {
    runAudit: async () => opts.findings,
    delegateAuto: async (task) => {
      opts.spy?.autoCalls.push(task);
      return opts.auto(task);
    },
    delegateMerge: async (prs) => {
      opts.spy?.mergeCalls.push(prs);
      return opts.merge(prs);
    },
  };
}

test("full green sweep: 2 HIGH + 1 MED → 3 PRs opened → 3 merged, ledger persisted", async () => {
  const root = await ws();
  try {
    const findings: AuditFinding[] = [
      { filePath: "src/a.ts:10", severity: "HIGH", claim: "a" },
      { filePath: "src/b.ts:20", severity: "HIGH", claim: "b" },
      { filePath: "src/c.ts:30", severity: "MED", claim: "c" },
    ];
    let pr = 100;
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const seams = seamsFrom({
      findings,
      auto: () => ({ exitCode: 0, prNumber: ++pr }),
      merge: (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    });
    const report = await runAuditSweep(root, {}, { seams, now: "2026-07-15T00:00:00Z" });
    assert.equal(report.findingsFound, 3);
    assert.equal(report.tasksCreated, 3);
    assert.equal(report.prsOpened, 3);
    assert.equal(report.prsMerged, 3);
    assert.equal(spy.autoCalls.length, 3);
    assert.deepEqual(spy.mergeCalls, [[101, 102, 103]]);

    const ledger = await loadSweepState(root);
    assert.equal(ledger.lastSweep, "2026-07-15T00:00:00Z");
    assert.equal(Object.values(ledger.findings).filter((f) => f.status === "fixed").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--no-fix stops after triage: no delegateAuto, no delegateMerge, no ledger persisted as fixed", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const seams = seamsFrom({
      findings: [{ filePath: "src/a.ts:10", severity: "HIGH", claim: "a" }],
      auto: () => ({ exitCode: 0, prNumber: 1 }),
      merge: (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    });
    const report = await runAuditSweep(root, { noFix: true }, { seams, now: "t" });
    assert.equal(report.tasksCreated, 1);
    assert.equal(report.prsOpened, 0);
    assert.equal(spy.autoCalls.length, 0);
    assert.equal(spy.mergeCalls.length, 0);
    const ledger = await loadSweepState(root);
    assert.equal(Object.values(ledger.findings).filter((f) => f.status === "fixed").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--no-merge stops after fix: delegateMerge never called, PRs left open", async () => {
  const root = await ws();
  try {
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const seams = seamsFrom({
      findings: [{ filePath: "src/a.ts:10", severity: "HIGH", claim: "a" }],
      auto: () => ({ exitCode: 0, prNumber: 5 }),
      merge: (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    });
    const report = await runAuditSweep(root, { noMerge: true }, { seams, now: "t" });
    assert.equal(report.prsOpened, 1);
    assert.equal(report.prsMerged, 0);
    assert.equal(spy.mergeCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart idempotency: already-fixed finding is skipped on re-run", async () => {
  const root = await ws();
  try {
    await saveSweepState(root, {
      lastSweep: "earlier",
      findings: { "src/a.ts:10": { severity: "HIGH", claim: "a", status: "fixed", pr: 1 } },
    });
    const spy = { autoCalls: [] as string[], mergeCalls: [] as number[][] };
    const seams = seamsFrom({
      findings: [
        { filePath: "src/a.ts:10", severity: "HIGH", claim: "a" },
        { filePath: "src/b.ts:20", severity: "HIGH", claim: "b" },
      ],
      auto: () => ({ exitCode: 0, prNumber: 2 }),
      merge: (prs) => prs.map((p) => ({ pr: p, outcome: "merged" as const })),
      spy,
    });
    const report = await runAuditSweep(root, {}, { seams, now: "t" });
    // Only the new finding is attempted.
    assert.equal(report.tasksCreated, 1);
    assert.equal(spy.autoCalls.length, 1);
    assert.match(spy.autoCalls[0], /src\/b\.ts:20/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaultSeams.runAudit parses the latest findings doc under plans/audit/", async () => {
  const root = await ws();
  try {
    const dir = path.join(root, "plans", "audit");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "inhouse-findings-2026-01-01.md"), "- `src/old.ts:1` · **HIGH** · old\n");
    await writeFile(path.join(dir, "inhouse-findings-2026-09-09.md"), `- ${HI}\n- ${MED}\n`);
    const seams = defaultSeams(root);
    const findings = await seams.runAudit({});
    // Lexically-latest doc wins.
    assert.deepEqual(
      findings.map((f) => f.filePath).sort(),
      ["src/a.ts:10", "src/b.ts:20"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
