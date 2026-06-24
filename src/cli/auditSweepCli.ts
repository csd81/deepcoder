/**
 * `deepcoder audit sweep` — the self-maintenance loop entrypoint.
 *
 * Composes the pure orchestrator (`runSelfMaintain`) with real seams:
 *   - audit  : parse the latest synthesis doc under plans/audit/ for findings
 *   - fix    : `runDelegateAuto` per HIGH/MED finding (TDD, gate-checked PR)
 *   - merge  : `runDelegateMerge` over the opened PRs (re-gated before merge)
 * and the on-disk ledger (`plans/audit/.sweep-state.json`) for restartability.
 *
 * Every seam is injectable (`deps`) so the whole sweep is unit-testable with no
 * live model, no `gh`, and no real git. The CLI wiring only supplies defaults.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  runSelfMaintain,
  type AuditFinding,
  type DelegateAutoSeamResult,
  type DelegateMergeSeamResult,
  type SelfMaintainSeams,
  type SweepOptions,
  type SweepReport,
} from "../delegate/selfMaintain.js";
import { runDelegateAuto, runDelegateMerge } from "./delegateCli.js";
import { parseAuditFindings } from "../audit/findingsParser.js";
import { loadSweepState, mergeLedger, saveSweepState } from "../audit/sweepState.js";

const AUDIT_DIR = path.join("plans", "audit");

/** Parse a PR number out of a PR URL (…/pull/342) or "#342" reference. */
export function prNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = /(?:\/pull\/|#)(\d+)/.exec(url);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Find the newest non-hidden `*.md` under plans/audit/ (lexical max == latest by date-stamped name). */
async function latestFindingsDoc(root: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(root, AUDIT_DIR));
  } catch {
    return null;
  }
  const docs = entries.filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort();
  return docs.length ? docs[docs.length - 1] : null;
}

/** Build the default, production seams over the real delegate pipeline. */
export function defaultSeams(root: string): SelfMaintainSeams {
  return {
    runAudit: async (): Promise<AuditFinding[]> => {
      const doc = await latestFindingsDoc(root);
      if (!doc) return [];
      const md = await fs.readFile(path.join(root, AUDIT_DIR, doc), "utf8");
      return parseAuditFindings(md);
    },
    delegateAuto: async (task: string, opts): Promise<DelegateAutoSeamResult> => {
      const res = await runDelegateAuto(root, task, { noPr: opts?.noPr });
      const prNumber = prNumberFromUrl(res.prUrls[0]);
      return {
        exitCode: res.exitCode,
        prNumber,
        prUrl: res.prUrls[0],
        reason:
          res.exitCode === 0
            ? undefined
            : res.exitCode === 2
              ? "plan/usage error — no applyable worker"
              : "worker not applyable (gate failed) — no PR opened",
      };
    },
    delegateMerge: async (prs: number[], opts): Promise<DelegateMergeSeamResult[]> => {
      const res = await runDelegateMerge(root, prs, { dryRun: opts?.dryRun });
      // Narrow PrMergeResult.outcome to the seam union; resolved-and-merged → merged.
      return res.results.map((r) => ({
        pr: r.pr,
        outcome: r.outcome === "resolved-and-merged" ? "merged" : r.outcome,
        failingGates: r.failingGates,
      }));
    },
  };
}

export interface AuditSweepDeps {
  seams?: SelfMaintainSeams;
  /** ISO timestamp stamped into the ledger (injected so the run is deterministic in tests). */
  now?: string;
  /** Override the ledger reader/writer (defaults to plans/audit/.sweep-state.json). */
  loadLedger?: (root: string) => Promise<import("../delegate/selfMaintain.js").SweepState>;
  saveLedger?: (root: string, state: import("../delegate/selfMaintain.js").SweepState) => Promise<void>;
}

export interface AuditSweepOptions {
  tracks?: string[];
  noFix?: boolean;
  noMerge?: boolean;
  dryRun?: boolean;
}

/**
 * Run the full sweep: load ledger → audit → triage → fix → merge → persist ledger.
 * A dry run reports what WOULD happen and never writes the ledger.
 */
export async function runAuditSweep(
  root: string,
  opts: AuditSweepOptions,
  deps: AuditSweepDeps = {},
): Promise<SweepReport> {
  const seams = deps.seams ?? defaultSeams(root);
  const loadLedger = deps.loadLedger ?? loadSweepState;
  const saveLedger = deps.saveLedger ?? saveSweepState;

  const ledger = await loadLedger(root);

  const sweepOpts: SweepOptions = {
    tracks: opts.tracks,
    noFix: opts.noFix,
    noMerge: opts.noMerge,
    dryRun: opts.dryRun,
    ledger,
  };

  const report = await runSelfMaintain(sweepOpts, seams);

  // Dry runs have no side effects — never touch the ledger.
  if (!opts.dryRun) {
    const now = deps.now ?? new Date().toISOString();
    await saveLedger(root, mergeLedger(ledger, report, now));
  }

  return report;
}

/** Render a human-readable one-screen summary of a sweep report. */
export function formatSweepReport(report: SweepReport): string {
  const lines: string[] = [];
  lines.push(
    report.dryRun ? "Audit sweep (dry run) —" : "Audit sweep —",
    `  findings:     ${report.findingsFound}`,
    `  tasks:        ${report.tasksCreated}`,
    `  PRs opened:   ${report.prsOpened}`,
    `  PRs merged:   ${report.prsMerged}`,
    `  skipped:      ${report.skipped.length}`,
  );
  for (const s of report.skipped) {
    lines.push(`    · ${s.finding.filePath} — ${s.reason}`);
  }
  for (const r of report.results) {
    const pr = r.fixResult?.prNumber ? `PR #${r.fixResult.prNumber}` : "no PR";
    const merge = r.mergeResult ? r.mergeResult.outcome : "—";
    lines.push(`    ✓ ${r.finding.filePath} — ${pr} / ${merge}`);
  }
  return lines.join("\n");
}

/**
 * Register `deepcoder audit sweep` on the commander program. Kept separate from
 * main.ts so it is unit-testable without executing the CLI.
 */
export function registerAuditSweepCommand(program: Command, deps: { root?: string } = {}): Command {
  const root = deps.root ?? process.cwd();

  const audit = program
    .command("audit")
    .description("repo self-maintenance: audit → triage → fix → merge (gate-checked, restartable)");

  audit
    .command("sweep")
    .description("run the self-maintenance loop over the latest audit findings")
    .option("--tracks <list>", "comma-separated audit tracks to fan out", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .option("--no-fix", "stop after triage — report findings, open no PRs")
    .option("--no-merge", "stop after fix — open PRs but do not merge")
    .option("--dry-run", "report what WOULD happen; no worktrees, PRs, merges, or ledger writes")
    .option("--json", "print the SweepReport as JSON")
    .action(
      async (o: { tracks?: string[]; fix?: boolean; merge?: boolean; dryRun?: boolean; json?: boolean }) => {
        // commander negates --no-fix/--no-merge into fix:false / merge:false.
        const report = await runAuditSweep(root, {
          tracks: o.tracks,
          noFix: o.fix === false,
          noMerge: o.merge === false,
          dryRun: o.dryRun,
        });
        if (o.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        } else {
          process.stdout.write(formatSweepReport(report) + "\n");
        }
        // Non-zero exit if any triaged finding failed to merge (gate stayed red).
        const unresolved = report.tasksCreated - report.prsMerged;
        process.exit(report.dryRun || unresolved === 0 ? 0 : 1);
      },
    );

  return audit;
}
