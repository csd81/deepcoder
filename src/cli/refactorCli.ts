/**
 * Headless auto-refactor CLI — `deepcoder refactor plan|run|validate|pr|auto`.
 *
 * A refactor-shaped specialization of the delegate pipeline: it auto-DISCOVERS
 * repo structure, drafts a per-area RefactorPlan, maps it onto a DelegationPlan
 * whose workers are stamped behavior-preserving (no test edits, production-only,
 * green suite), then reuses the delegate leaves to run (isolated worktrees),
 * validate (the 9 gates), and PR (gated on applyable; NEVER auto-merge).
 *
 * Note the naming: `src/cli/refactor.ts` already exists (the interactive
 * `/refactor` slash-command). This headless module is `refactorCli.ts`.
 *
 * It deliberately does NOT reuse `runDelegateAuto`: that path forces
 * `plan({tdd:true})` (workers self-seed NEW red tests), the opposite of a
 * behavior-preserving refactor. We compose run → validate → pr ourselves.
 */
import type { Command } from "commander";

import { discoverStructure, type RepoStructure } from "../refactor/discovery.js";
import { buildRefactorPlan, type RefactorPlan } from "../refactor/refactorPlan.js";
import { refactorPlanToDelegationPlan } from "../refactor/toRefactorWorkers.js";
import { savePlan, loadPlan } from "../delegate/store.js";
import { loadConfig } from "../config/config.js";
import { gitExec } from "../git/core.js";
import { loadAndValidateWorker } from "../delegate/validation.js";
import { runDelegateRun, runDelegateValidate, runDelegatePr } from "./delegateCli.js";
import type { DelegationPlan, WorkerValidation } from "../delegate/types.js";

// run/validate/pr ARE the delegate leaves — re-exported under refactor names so
// the command surface (and tests) have a cohesive `refactor*` API.
export { runDelegateRun as runRefactorRun, runDelegateValidate as runRefactorValidate, runDelegatePr as runRefactorPr } from "./delegateCli.js";

/* ------------------------------------------------------------------ */
/*  refactor plan — discover → RefactorPlan → DelegationPlan → save     */
/* ------------------------------------------------------------------ */

export interface RefactorPlanResult {
  /** 0 = plan saved; 2 = nothing to refactor (empty repo / unknown --area). */
  exitCode: number;
  planId: string | null;
}

export interface RefactorPlanOptions {
  /** Restrict to a single area (e.g. "auth" or "src/auth"). */
  area?: string;
}

interface RefactorPlanDeps {
  discover?: (root: string) => Promise<RepoStructure>;
  buildRefactorPlan?: (structure: RepoStructure) => RefactorPlan;
  toWorkers?: (plan: RefactorPlan, opts: { checkNames: string[] }) => DelegationPlan;
  savePlan?: (root: string, plan: DelegationPlan) => Promise<void>;
  /** Configured check names (so workers get a green-suite `checkName`). */
  checkNames?: () => string[];
}

/**
 * Build and persist a behavior-preserving refactor plan from auto-discovered
 * structure. Returns the new plan id. No model, no mutation beyond the saved
 * plan.json.
 */
export async function runRefactorPlan(
  root: string,
  opts: RefactorPlanOptions = {},
  deps: RefactorPlanDeps = {},
): Promise<RefactorPlanResult> {
  const discover = deps.discover ?? discoverStructure;
  const toRefactor = deps.buildRefactorPlan ?? buildRefactorPlan;
  const toWorkers = deps.toWorkers ?? refactorPlanToDelegationPlan;
  const savePlanFn = deps.savePlan ?? savePlan;
  const checkNames = deps.checkNames ? deps.checkNames() : defaultCheckNames();

  const structure = await discover(root);
  let refactor = toRefactor(structure);

  if (opts.area) {
    const want = normalizeArea(opts.area);
    refactor = { ...refactor, areas: refactor.areas.filter((a) => a.area === want) };
    if (refactor.areas.length === 0) return { exitCode: 2, planId: null };
  }

  if (refactor.areas.length === 0) return { exitCode: 2, planId: null };

  const plan = toWorkers(refactor, { checkNames });
  await savePlanFn(root, plan);
  return { exitCode: 0, planId: plan.id };
}

/* ------------------------------------------------------------------ */
/*  refactor auto — plan → run → validate → pr (gated, never merge)     */
/* ------------------------------------------------------------------ */

export interface RefactorAutoResult {
  /** 0 = every worker applyable (PR'd unless noPr); 1 = some not applyable; 2 = plan error. */
  exitCode: number;
  planId: string | null;
  prUrls: string[];
}

interface RefactorAutoDeps {
  plan?: (root: string, opts: RefactorPlanOptions) => Promise<RefactorPlanResult>;
  run?: (root: string, planId: string, o: { concurrent?: boolean }) => Promise<{ exitCode: number; result: unknown }>;
  loadPlan?: (root: string, planId: string) => Promise<DelegationPlan | null>;
  validate?: (root: string, planId: string, workerId: string) => Promise<WorkerValidation>;
  pr?: (root: string, planId: string, workerId: string) => Promise<{ exitCode: number; prUrl?: string }>;
}

/**
 * Autonomous discover → plan → run → validate → pr. A non-applyable worker NEVER
 * opens a PR (the autonomy gate); nothing is ever merged. Seams default to the
 * real pipeline so tests inject fakes with no model, no worktree, no GitHub.
 */
export async function runRefactorAuto(
  root: string,
  opts: { area?: string; concurrent?: boolean; noPr?: boolean; base?: string } = {},
  deps: RefactorAutoDeps = {},
): Promise<RefactorAutoResult> {
  const planFn = deps.plan ?? ((r, o) => runRefactorPlan(r, o));
  const runFn = deps.run ?? ((r, p, o) => runDelegateRun(r, p, undefined, o));
  const loadPlanFn = deps.loadPlan ?? loadPlan;
  const validateFn = deps.validate ?? loadAndValidateWorker;
  const prFn = deps.pr ?? ((r, p, w) => runDelegatePr(r, p, w, { base: opts.base }));

  // 1. Plan (behavior-preserving; NO tdd).
  const planResult = await planFn(root, { area: opts.area });
  if (planResult.exitCode !== 0 || !planResult.planId) {
    return { exitCode: 2, planId: null, prUrls: [] };
  }
  const planId = planResult.planId;

  // 2. Run — proceed even on failure (non-green workers become non-applyable).
  await runFn(root, planId, { concurrent: opts.concurrent });

  // 3. Enumerate + validate each worker.
  const plan = await loadPlanFn(root, planId);
  if (!plan) return { exitCode: 2, planId, prUrls: [] };

  const validations: { workerId: string; applyable: boolean }[] = [];
  for (const w of plan.workers) {
    const v = await validateFn(root, planId, w.id);
    validations.push({ workerId: w.id, applyable: v.applyable });
  }

  // 4. PR only applyable workers (unless --no-pr). Never merges.
  const prUrls: string[] = [];
  if (!opts.noPr) {
    for (const { workerId, applyable } of validations) {
      if (!applyable) continue;
      const prResult = await prFn(root, planId, workerId);
      if (prResult.prUrl) prUrls.push(prResult.prUrl);
    }
  }

  const allApplyable = validations.length > 0 && validations.every((v) => v.applyable);
  return { exitCode: allApplyable ? 0 : 1, planId, prUrls };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function defaultCheckNames(): string[] {
  try {
    return Object.keys(loadConfig().checks ?? {});
  } catch {
    return [];
  }
}

/** "auth" → "src/auth"; "src/auth" stays; trailing slash trimmed. */
function normalizeArea(area: string): string {
  const a = area.replace(/\/+$/, "");
  return a.startsWith("src/") ? a : `src/${a}`;
}

/** Friendly fail-closed guard: the refactor pipeline needs a git repo. */
async function ensureGitRepo(root: string): Promise<boolean> {
  const res = await gitExec(root, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout.trim() === "true";
}

/* ------------------------------------------------------------------ */
/*  Commander wiring                                                   */
/* ------------------------------------------------------------------ */

/**
 * Register the `refactor` command (and subcommands) on a commander program.
 * Kept separate from main.ts so it is unit-testable without executing the CLI.
 */
export function registerRefactorCommand(program: Command, deps: { root?: string } = {}): Command {
  const root = deps.root ?? process.cwd();

  const refactor = program
    .command("refactor")
    .description("auto-refactor pipeline: discover → plan → run → validate → PR (behavior-preserving, never auto-merge)");

  refactor
    .command("plan")
    .description("auto-discover structure and persist a behavior-preserving refactor plan; prints the plan id")
    .option("--area <name>", "restrict to a single area (e.g. auth or src/auth)")
    .action(async (o: { area?: string }) => {
      if (!(await ensureGitRepo(root))) {
        process.stderr.write("refactor plan: not a git repository (run `git init` first)\n");
        process.exit(2);
      }
      const res = await runRefactorPlan(root, { area: o.area });
      if (res.exitCode !== 0) {
        process.stderr.write(`refactor plan: nothing to refactor${o.area ? ` for area "${o.area}"` : " under src/"}\n`);
        process.exit(res.exitCode);
      }
      process.stdout.write(`${res.planId}\n`);
      process.exit(0);
    });

  refactor
    .command("run <plan-id> [worker-id]")
    .description("run a refactor plan's workers in isolated worktrees (nothing applied)")
    .option("--concurrent", "run independent workers concurrently")
    .option("--json", "print the orchestration result as JSON")
    .action(async (planId: string, workerId: string | undefined, o: { concurrent?: boolean; json?: boolean }) => {
      if (!(await ensureGitRepo(root))) {
        process.stderr.write("refactor run: not a git repository\n");
        process.exit(2);
      }
      const res = await runDelegateRun(root, planId, workerId, { concurrent: o.concurrent });
      if (res.exitCode === 2) {
        process.stderr.write(`refactor run: plan "${planId}" not found\n`);
        process.exit(2);
      }
      if (o.json) process.stdout.write(JSON.stringify(res.result, null, 2) + "\n");
      else if (res.result) {
        for (const r of res.result.ran) process.stdout.write(`${r.workerId}: ${r.passed ? "passed" : "FAILED"} (${r.changedFiles.length} files)\n`);
      }
      process.exit(res.exitCode);
    });

  refactor
    .command("validate <plan-id> [worker-id]")
    .description("run the 9-gate validator on a refactor worker; exit 0 iff applyable")
    .option("--json", "print the WorkerValidation verdict(s) as JSON")
    .action(async (planId: string, workerId: string | undefined, o: { json?: boolean }) => {
      const res = await runDelegateValidate(root, planId, workerId);
      if (res.exitCode === 2) {
        process.stderr.write(`refactor validate: plan "${planId}" not found or has no workers\n`);
        process.exit(2);
      }
      if (o.json) process.stdout.write(JSON.stringify(res.results.map((r) => ({ workerId: r.workerId, applyable: r.validation.applyable })), null, 2) + "\n");
      else for (const r of res.results) process.stdout.write(`${r.workerId}: ${r.validation.applyable ? "applyable" : "NOT applyable"}\n`);
      process.exit(res.exitCode);
    });

  refactor
    .command("pr <plan-id> <worker-id>")
    .description("open a PR for a refactor worker (gated on applyable; never auto-merges)")
    .option("--base <branch>", "base branch for the PR (default: master)")
    .action(async (planId: string, workerId: string, o: { base?: string }) => {
      const res = await runDelegatePr(root, planId, workerId, { base: o.base });
      if (res.exitCode !== 0) {
        process.stderr.write(`refactor pr: worker "${workerId}" is NOT applyable — no PR opened\n`);
        process.exit(res.exitCode);
      }
      process.stdout.write(`PR opened: ${res.prUrl}\n`);
      process.exit(0);
    });

  refactor
    .command("auto")
    .description("autonomous discover → plan → run → validate → PR (gated on applyable; never auto-merges)")
    .option("--area <name>", "restrict to a single area")
    .option("--concurrent", "run independent workers concurrently")
    .option("--no-pr", "stop after validation; do not open PRs")
    .option("--base <branch>", "base branch for PRs")
    .option("--json", "print the result as JSON")
    .action(async (o: { area?: string; concurrent?: boolean; pr?: boolean; base?: string; json?: boolean }) => {
      if (!(await ensureGitRepo(root))) {
        process.stderr.write("refactor auto: not a git repository\n");
        process.exit(2);
      }
      const res = await runRefactorAuto(root, {
        area: o.area,
        concurrent: o.concurrent,
        noPr: o.pr === false,
        base: o.base,
      });
      if (o.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      else {
        process.stdout.write(`plan: ${res.planId}\nexit: ${res.exitCode}\n`);
        for (const url of res.prUrls) process.stdout.write(`PR: ${url}\n`);
      }
      process.exit(res.exitCode);
    });

  return refactor;
}
