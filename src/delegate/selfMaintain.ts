/**
 * Pure self-maintenance orchestrator — audit → triage → fix → merge.
 *
 * All side effects are injected as seams: runAudit, delegateAuto, delegateMerge.
 * The merge gate is non-negotiable: a non-applyable PR is NEVER merged.
 *
 * No live model, no git, no `gh` required to test — every seam is injectable.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AuditFinding {
  /** Location, e.g. "src/security/monitor.ts:142" */
  filePath: string;
  severity: "HIGH" | "MED" | "LOW";
  claim: string;
}

export interface SweepState {
  lastSweep: string;
  findings: Record<
    string,
    {
      severity: string;
      claim: string;
      status: "fixed" | "attempted" | null;
      pr: number | null;
      reason?: string;
    }
  >;
}

export interface DelegateAutoSeamResult {
  exitCode: number;
  prNumber: number | null;
  prUrl?: string;
  /** Reason for failure when prNumber is null. */
  reason?: string;
}

export interface DelegateMergeSeamResult {
  pr: number;
  outcome: "merged" | "skipped-not-applyable" | "conflicts-unresolved" | "error";
  failingGates?: string[];
}

export interface SweepOptions {
  /** Audit tracks to fan out. */
  tracks?: string[];
  /** Stop after triage — no fix, no merge. */
  noFix?: boolean;
  /** Stop after fix — PRs open, merge not called. */
  noMerge?: boolean;
  /** Report what WOULD happen, no side effects. */
  dryRun?: boolean;
  /** Current ledger state for deduplication (empty → first run). */
  ledger?: SweepState;
}

export interface SweepTask {
  finding: AuditFinding;
  taskString: string;
}

export interface SweepTaskResult {
  finding: AuditFinding;
  task: string;
  fixResult: DelegateAutoSeamResult | null;
  mergeResult: DelegateMergeSeamResult | null;
}

export interface SweepReport {
  findingsFound: number;
  tasksCreated: number;
  prsOpened: number;
  prsMerged: number;
  skipped: { finding: AuditFinding; reason: string }[];
  results: SweepTaskResult[];
  dryRun: boolean;
}

export interface SelfMaintainSeams {
  runAudit: (opts: { tracks?: string[] }) => Promise<AuditFinding[]>;
  delegateAuto: (
    task: string,
    opts?: { tdd?: boolean; noPr?: boolean },
  ) => Promise<DelegateAutoSeamResult>;
  delegateMerge: (
    prs: number[],
    opts?: { dryRun?: boolean },
  ) => Promise<DelegateMergeSeamResult[]>;
}

/* ------------------------------------------------------------------ */
/*  Triage                                                             */
/* ------------------------------------------------------------------ */

const VALID_SEVERITIES = new Set(["HIGH", "MED", "LOW"]);

function isValidSeverity(s: string): s is "HIGH" | "MED" | "LOW" {
  return VALID_SEVERITIES.has(s);
}

/**
 * Parse the audit findings into a task list, filtering to HIGH/MED,
 * deduplicating against the ledger, and rejecting invalid severities.
 */
function triage(
  findings: AuditFinding[],
  ledger: SweepState | undefined,
): { tasks: SweepTask[]; skipped: { finding: AuditFinding; reason: string }[] } {
  const tasks: SweepTask[] = [];
  const skipped: { finding: AuditFinding; reason: string }[] = [];
  const ledgerEntries = ledger?.findings ?? {};

  for (const f of findings) {
    // Reject invalid severities (e.g. CRITICAL) — don't blindly trust input.
    if (!isValidSeverity(f.severity)) {
      skipped.push({
        finding: f,
        reason: `invalid severity "${f.severity}" — only HIGH/MED/LOW accepted`,
      });
      continue;
    }

    // LOW findings are recorded but never auto-fixed.
    if (f.severity === "LOW") {
      skipped.push({ finding: f, reason: "LOW severity — not auto-fixed" });
      continue;
    }

    // Deduplicate against ledger: skip already-fixed or already-attempted.
    const entry = ledgerEntries[f.filePath];
    if (entry) {
      if (entry.status === "fixed") {
        skipped.push({ finding: f, reason: "already fixed in ledger" });
        continue;
      }
      if (entry.status === "attempted") {
        skipped.push({
          finding: f,
          reason: `previously attempted: ${entry.reason ?? "unknown reason"}`,
        });
        continue;
      }
    }

    const taskString = `Fix ${f.severity} finding: ${f.claim} at ${f.filePath}. TDD required.`;
    tasks.push({ finding: f, taskString });
  }

  return { tasks, skipped };
}

/* ------------------------------------------------------------------ */
/*  Orchestrator                                                       */
/* ------------------------------------------------------------------ */

export async function runSelfMaintain(
  opts: SweepOptions,
  seams: SelfMaintainSeams,
): Promise<SweepReport> {
  // 1. Audit
  const findings = await seams.runAudit({ tracks: opts.tracks });

  // 2. Triage
  const { tasks, skipped } = triage(findings, opts.ledger);

  // Dry-run: stop after triage, no side effects.
  if (opts.dryRun) {
    return {
      findingsFound: findings.length,
      tasksCreated: tasks.length,
      prsOpened: 0,
      prsMerged: 0,
      skipped,
      results: tasks.map((t) => ({
        finding: t.finding,
        task: t.taskString,
        fixResult: null,
        mergeResult: null,
      })),
      dryRun: true,
    };
  }

  // No tasks? Done.
  if (tasks.length === 0) {
    return {
      findingsFound: findings.length,
      tasksCreated: 0,
      prsOpened: 0,
      prsMerged: 0,
      skipped,
      results: [],
      dryRun: false,
    };
  }

  // --no-fix: stop after triage.
  if (opts.noFix) {
    return {
      findingsFound: findings.length,
      tasksCreated: tasks.length,
      prsOpened: 0,
      prsMerged: 0,
      skipped,
      results: tasks.map((t) => ({
        finding: t.finding,
        task: t.taskString,
        fixResult: null,
        mergeResult: null,
      })),
      dryRun: false,
    };
  }

  // 3. Fix — delegateAuto per task (sequentially; ordering matters for conflict safety).
  const results: SweepTaskResult[] = [];
  const openedPrs: number[] = [];
  const fixSkipped: { finding: AuditFinding; reason: string }[] = [...skipped];

  for (const task of tasks) {
    const fixResult = await seams.delegateAuto(task.taskString, {
      tdd: true,
      noPr: false,
    });

    if (fixResult.prNumber !== null) {
      openedPrs.push(fixResult.prNumber);
    } else {
      fixSkipped.push({
        finding: task.finding,
        reason: fixResult.reason ?? "delegateAuto did not open a PR",
      });
    }

    results.push({
      finding: task.finding,
      task: task.taskString,
      fixResult,
      mergeResult: null,
    });
  }

  // 4. Merge — delegateMerge over all opened PRs (unless --no-merge).
  if (!opts.noMerge && openedPrs.length > 0) {
    const mergeResults = await seams.delegateMerge(openedPrs, { dryRun: false });

    for (const mr of mergeResults) {
      // Match merge result back to the task result.
      const taskResult = results.find(
        (r) => r.fixResult?.prNumber === mr.pr,
      );
      if (taskResult) {
        taskResult.mergeResult = mr;
      }

      if (mr.outcome !== "merged") {
        const finding = results.find(
          (r) => r.fixResult?.prNumber === mr.pr,
        )?.finding;
        if (finding) {
          fixSkipped.push({
            finding,
            reason: `merge ${mr.outcome}${mr.failingGates ? `: ${mr.failingGates.join(", ")}` : ""}`,
          });
        }
      }
    }
  }

  const mergedCount = results.filter(
    (r) => r.mergeResult?.outcome === "merged",
  ).length;

  return {
    findingsFound: findings.length,
    tasksCreated: tasks.length,
    prsOpened: openedPrs.length,
    prsMerged: mergedCount,
    skipped: fixSkipped,
    results,
    dryRun: false,
  };
}
