/**
 * Headless delegation CLI — drives the built-in delegation pipeline (the same
 * validation gates as the interactive `/delegate`) without a TTY, so it is
 * scriptable. This file holds the testable logic + the commander wiring; see
 * plans/new/feat-headless-delegate-cli-plan.md.
 *
 * Slice 1: `deepcoder delegate validate <plan-id> [worker-id]` — runs the
 * 9-gate validator (loadAndValidateWorker) and exits 0 iff every selected worker
 * is applyable, so a script can gate a commit/PR on the REAL verification rather
 * than a bare `--check` exit code.
 */
import type { Command } from "commander";
import { loadAndValidateWorker } from "../delegate/validation.js";
import { loadPlan } from "../delegate/store.js";
import type { DelegationPlan, WorkerValidation } from "../delegate/types.js";

export interface DelegateValidateResult {
  /** 0 = all selected workers applyable; 1 = some not applyable; 2 = plan/usage error. */
  exitCode: number;
  results: { workerId: string; validation: WorkerValidation }[];
}

interface ValidateDeps {
  loadPlan?: (root: string, planId: string) => Promise<DelegationPlan | null>;
  validate?: (
    root: string,
    planId: string,
    workerId: string,
    opts?: { requireDeliverableTested?: boolean },
  ) => Promise<WorkerValidation>;
}

/**
 * Validate one worker (when workerId given) or every worker in the plan. Returns
 * the per-worker verdicts and an aggregate exit code. Side-effect-free beyond
 * whatever the injected validator writes (loadAndValidateWorker persists
 * validation.json by design).
 */
export async function runDelegateValidate(
  root: string,
  planId: string,
  workerId: string | undefined,
  opts: { requireDeliverableTested?: boolean } = {},
  deps: ValidateDeps = {},
): Promise<DelegateValidateResult> {
  const loadPlanFn = deps.loadPlan ?? loadPlan;
  const validateFn = deps.validate ?? loadAndValidateWorker;

  const plan = await loadPlanFn(root, planId);
  if (!plan) return { exitCode: 2, results: [] };

  const ids = workerId ? [workerId] : plan.workers.map((w) => w.id);
  if (ids.length === 0) return { exitCode: 2, results: [] };

  const results: DelegateValidateResult["results"] = [];
  for (const id of ids) {
    const validation = await validateFn(root, planId, id, opts);
    results.push({ workerId: id, validation });
  }

  const allApplyable = results.every((r) => r.validation.applyable);
  return { exitCode: allApplyable ? 0 : 1, results };
}

/** Render a human-readable validation summary (used when --json is absent). */
export function formatValidateSummary(results: DelegateValidateResult["results"]): string {
  const lines: string[] = [];
  for (const r of results) {
    const tag = r.validation.applyable ? "applyable" : "NOT applyable";
    lines.push(`${r.workerId}: ${r.validation.status} (${tag})`);
    for (const f of r.validation.failures) lines.push(`  ✗ ${f.code}: ${f.message}`);
    for (const w of r.validation.warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join("\n");
}

/**
 * Register the `delegate` command (and its subcommands) on a commander program.
 * Kept separate from main.ts so it is unit-testable without executing the CLI.
 */
export function registerDelegateCommand(program: Command, deps: { root?: string } = {}): Command {
  const root = deps.root ?? process.cwd();

  const delegate = program
    .command("delegate")
    .description("headless delegation pipeline (validate/run/apply/pr) — scriptable, no TTY");

  delegate
    .command("validate <plan-id> [worker-id]")
    .description("run the 9-gate validator on a delegated worker (all workers if omitted); exit 0 iff applyable")
    .option("--json", "print the WorkerValidation verdict(s) as JSON")
    .option("--require-deliverable-tested", "enforce the test-delta gate (deliverable_untested)")
    .action(async (planId: string, workerId: string | undefined, o: { json?: boolean; requireDeliverableTested?: boolean }) => {
      const res = await runDelegateValidate(root, planId, workerId, {
        requireDeliverableTested: o.requireDeliverableTested,
      });
      if (res.exitCode === 2) {
        process.stderr.write(`delegate validate: plan "${planId}" not found or has no workers\n`);
        process.exit(2);
      }
      if (o.json) {
        const payload = res.results.length === 1 ? res.results[0].validation : res.results;
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      } else {
        process.stdout.write(formatValidateSummary(res.results) + "\n");
      }
      process.exit(res.exitCode);
    });

  return delegate;
}
