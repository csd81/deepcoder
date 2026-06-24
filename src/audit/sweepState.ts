/**
 * Read/write the audit-sweep ledger (`plans/audit/.sweep-state.json`).
 *
 * The ledger makes the sweep restartable: findings already `fixed` or
 * `attempted` are skipped on re-run. Writes are atomic (write-temp + rename) so
 * an interrupted sweep never leaves a half-written ledger. `fixed` entries are
 * append-only — `mergeLedger` never downgrades a `fixed` finding.
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SweepReport, SweepState } from "../delegate/selfMaintain.js";

/** Workspace-relative location of the ledger. */
export const LEDGER_REL = path.join("plans", "audit", ".sweep-state.json");

export function ledgerPath(root: string): string {
  return path.join(root, LEDGER_REL);
}

/** Load the ledger; a missing or corrupt file yields a fresh, empty ledger. */
export async function loadSweepState(root: string): Promise<SweepState> {
  try {
    const raw = await fs.readFile(ledgerPath(root), "utf8");
    const parsed = JSON.parse(raw) as SweepState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.findings !== "object") {
      return { lastSweep: "", findings: {} };
    }
    return { lastSweep: parsed.lastSweep ?? "", findings: parsed.findings ?? {} };
  } catch {
    return { lastSweep: "", findings: {} };
  }
}

/** Atomically persist the ledger (creates `plans/audit/` if missing). */
export async function saveSweepState(root: string, state: SweepState): Promise<void> {
  const file = ledgerPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Fold a finished sweep's report into the previous ledger.
 *
 * - A merged PR records the finding as `fixed` (with its PR number).
 * - A finding that produced no merge (no PR, gate failed, merge blocked) records
 *   as `attempted` with the reason — the human triages these.
 * - Existing `fixed` entries are never downgraded (append-only invariant).
 *
 * `now` is injected (ISO string) so the merge is a pure function — no clock read.
 */
export function mergeLedger(prev: SweepState, report: SweepReport, now: string): SweepState {
  const findings: SweepState["findings"] = { ...prev.findings };

  const keep = (key: string): boolean => findings[key]?.status === "fixed";

  for (const r of report.results) {
    const key = r.finding.filePath;
    if (keep(key)) continue;
    if (r.mergeResult?.outcome === "merged") {
      findings[key] = {
        severity: r.finding.severity,
        claim: r.finding.claim,
        status: "fixed",
        pr: r.fixResult?.prNumber ?? r.mergeResult.pr ?? null,
      };
    } else {
      const reason = r.mergeResult
        ? `merge ${r.mergeResult.outcome}${r.mergeResult.failingGates ? `: ${r.mergeResult.failingGates.join(", ")}` : ""}`
        : (r.fixResult?.reason ?? "fix did not produce a merged PR");
      findings[key] = {
        severity: r.finding.severity,
        claim: r.finding.claim,
        status: "attempted",
        pr: r.fixResult?.prNumber ?? null,
        reason,
      };
    }
  }

  // Skipped findings that were genuinely attempted-and-failed (not LOW / dedup)
  // are not re-recorded here — the orchestrator already carries their status.
  return { lastSweep: now, findings };
}
