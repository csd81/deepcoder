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
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { loadAndValidateWorker } from "../delegate/validation.js";
import { loadPlan } from "../delegate/store.js";
import { runRunnable, runRunnableConcurrent, type OrchestrationResult } from "../delegate/orchestrator.js";
import { applyWorker, type ApplyResult } from "../delegate/apply.js";
import { buildPlan } from "../delegate/planner.js";
import { savePlan } from "../delegate/store.js";
import { loadConfig } from "../config/config.js";
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

/* ------------------------------------------------------------------ */
/*  delegate plan — headless plan creation (heuristic, no model)        */
/* ------------------------------------------------------------------ */

export interface DelegatePlanResult {
  exitCode: number;
  planId: string | null;
}

interface PlanDeps {
  buildPlan?: typeof buildPlan;
  savePlan?: (root: string, plan: DelegationPlan) => Promise<void>;
}

/**
 * Build a DelegationPlan from a free-text task and persist it, returning the new
 * plan id. Uses the deterministic heuristic planner (no model), so the headless
 * chain `delegate plan → run → validate → apply` needs no live provider to wire
 * the plan. Checks default to the configured set so workers get a `checkName`.
 */
export async function runDelegatePlan(
  root: string,
  task: string,
  opts: { maxWorkers?: number; tdd?: boolean; acceptanceFirst?: boolean } = {},
  deps: PlanDeps = {},
): Promise<DelegatePlanResult> {
  if (!task.trim()) return { exitCode: 2, planId: null };
  const buildPlanFn = deps.buildPlan ?? buildPlan;
  const savePlanFn = deps.savePlan ?? savePlan;

  let checkNames: string[] = [];
  if (!deps.buildPlan) {
    try {
      checkNames = Object.keys(loadConfig().checks ?? {});
    } catch {
      checkNames = [];
    }
  }

  const plan = buildPlanFn(task, {
    checkNames,
    maxWorkers: opts.maxWorkers,
    tdd: opts.tdd,
    acceptanceFirst: opts.acceptanceFirst,
  });
  await savePlanFn(root, plan);
  return { exitCode: 0, planId: plan.id };
}

/* ------------------------------------------------------------------ */
/*  delegate run — headless worker execution                           */
/* ------------------------------------------------------------------ */

export interface DelegateRunResult {
  /** 0 = all ran workers passed, no conflicts; 1 = a failure/conflict; 2 = plan/usage error. */
  exitCode: number;
  result: OrchestrationResult | null;
}

interface RunDeps {
  loadPlan?: (root: string, planId: string) => Promise<DelegationPlan | null>;
  /** Seam over runRunnable/runRunnableConcurrent (tests inject a fake). */
  runRunnable?: (plan: DelegationPlan) => Promise<OrchestrationResult>;
}

/**
 * Headlessly run a plan's runnable workers (or a single worker) through the
 * built-in orchestrator — the same path as the interactive `/delegate run`, but
 * without the TTY gate (invoking this command IS the authorization). Each worker
 * still runs in an isolated worktree the runner owns; nothing is applied.
 */
export async function runDelegateRun(
  root: string,
  planId: string,
  workerId: string | undefined,
  opts: { concurrent?: boolean } = {},
  deps: RunDeps = {},
): Promise<DelegateRunResult> {
  const loadPlanFn = deps.loadPlan ?? loadPlan;
  const plan = await loadPlanFn(root, planId);
  if (!plan) return { exitCode: 2, result: null };

  // Narrow to a single worker when requested (the orchestrator runs the whole
  // runnable set; for one worker we hand it a plan view with just that worker).
  let target = plan;
  if (workerId) {
    const worker = plan.workers.find((w) => w.id === workerId);
    if (!worker) return { exitCode: 2, result: null };
    target = { ...plan, workers: [worker] };
  }

  const runFn =
    deps.runRunnable ??
    (async (p: DelegationPlan): Promise<OrchestrationResult> => {
      const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
      const provider = loadConfig().provider;
      const ac = new AbortController();
      const runOpts = {
        realRoot: root,
        signal: ac.signal,
        mainEntry,
        provider,
        parentEnv: process.env,
        onData: (chunk: string) => process.stdout.write(chunk),
      };
      return opts.concurrent
        ? runRunnableConcurrent(p, runOpts)
        : runRunnable(p, runOpts);
    });

  const result = await runFn(target);
  const ok = result.conflicts.length === 0 && result.ran.length > 0 && result.ran.every((r) => r.passed);
  return { exitCode: ok ? 0 : 1, result };
}

/* ------------------------------------------------------------------ */
/*  delegate apply — headless apply of a validated worker              */
/* ------------------------------------------------------------------ */

export interface DelegateApplyResult {
  exitCode: number;
  result: ApplyResult;
}

interface ApplyDeps {
  apply?: (root: string, planId: string, workerId: string, opts?: unknown) => Promise<ApplyResult>;
}

/**
 * Headlessly apply a worker's patch. applyWorker re-runs the validation gates
 * internally and refuses an unvalidated/invalid worker, so this never lands work
 * that wouldn't pass `delegate validate`.
 */
export async function runDelegateApply(
  root: string,
  planId: string,
  workerId: string,
  opts: { requireValidatedTest?: boolean } = {},
  deps: ApplyDeps = {},
): Promise<DelegateApplyResult> {
  const applyFn = deps.apply ?? (applyWorker as ApplyDeps["apply"]);
  const result = await applyFn!(root, planId, workerId, {
    // Non-interactive: never block on a confirm prompt.
    isTTY: false,
    confirmResult: true,
    requireValidatedTest: opts.requireValidatedTest,
  });
  return { exitCode: result.ok ? 0 : 1, result };
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

  delegate
    .command("plan <task...>")
    .description("build + persist a DelegationPlan from a task (heuristic, no model); prints the plan id")
    .option("--max-workers <n>", "max worker tasks (1-5, default 5)", (v) => parseInt(v, 10))
    .option("--tdd", "stamp every worker TDD-required")
    .option("--acceptance-first", "TDD + require a production change (reject test-only fixes)")
    .action(async (taskParts: string[], o: { maxWorkers?: number; tdd?: boolean; acceptanceFirst?: boolean }) => {
      const res = await runDelegatePlan(root, taskParts.join(" "), {
        maxWorkers: o.maxWorkers,
        tdd: o.tdd,
        acceptanceFirst: o.acceptanceFirst,
      });
      if (res.exitCode !== 0) {
        process.stderr.write("delegate plan: empty task\n");
        process.exit(res.exitCode);
      }
      process.stdout.write(`${res.planId}\n`);
      process.exit(0);
    });

  delegate
    .command("run <plan-id> [worker-id]")
    .description("headlessly run a plan's runnable workers (or one) in isolated worktrees; nothing is applied")
    .option("--concurrent", "run independent workers concurrently (disjoint locks)")
    .option("--json", "print the orchestration result as JSON")
    .action(async (planId: string, workerId: string | undefined, o: { concurrent?: boolean; json?: boolean }) => {
      const res = await runDelegateRun(root, planId, workerId, { concurrent: o.concurrent });
      if (res.exitCode === 2) {
        process.stderr.write(`delegate run: plan "${planId}"${workerId ? `/worker "${workerId}"` : ""} not found\n`);
        process.exit(2);
      }
      if (o.json) process.stdout.write(JSON.stringify(res.result, null, 2) + "\n");
      else if (res.result) {
        for (const r of res.result.ran) process.stdout.write(`${r.workerId}: ${r.passed ? "passed" : "FAILED"} (${r.changedFiles.length} files)\n`);
        for (const s of res.result.skipped) process.stdout.write(`${s.workerId}: skipped (${s.reason})\n`);
        for (const c of res.result.conflicts) process.stdout.write(`conflict: ${JSON.stringify(c)}\n`);
      }
      process.exit(res.exitCode);
    });

  delegate
    .command("apply <plan-id> <worker-id>")
    .description("headlessly apply a worker's patch (re-validates via the gates first; refuses if not applyable)")
    .option("--require-validated-test", "require a validated red→green test (green_confirmed) to apply")
    .option("--json", "print the apply result as JSON")
    .action(async (planId: string, workerId: string, o: { requireValidatedTest?: boolean; json?: boolean }) => {
      const res = await runDelegateApply(root, planId, workerId, { requireValidatedTest: o.requireValidatedTest });
      if (o.json) process.stdout.write(JSON.stringify(res.result, null, 2) + "\n");
      else process.stdout.write(`${res.result.ok ? "applied" : "refused"}: ${res.result.message}\n`);
      process.exit(res.exitCode);
    });

  return delegate;
}
