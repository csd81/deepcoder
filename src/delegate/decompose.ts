import { WorkerDeliverableSpec } from "./coverage.js";
import { assertSafeId } from "../workspace/paths.js";
import { isUnsafeForTargeting } from "../checks/testTargetPlanner.js";
import { buildPlan } from "./planner.js";
import { detectFileConflicts } from "./orchestrator.js";

export interface SubTaskSpec {
  id: string;
  title: string;
  goal: string;
  deliverables: WorkerDeliverableSpec[];
  allowedPaths: string[];
  testCommand?: string;
  dependsOn: string[];
  checkName: string;
}

export interface DecompositionPlan {
  task: string;
  subtasks: SubTaskSpec[];
  source: "model" | "heuristic";
  warnings: string[];
}

export interface ValidateDecompositionConfig {
  checks: string[];
  maxSubTasks?: number;
}

export interface ValidateDecompositionResult {
  ok: boolean;
  errors: string[];
  plan?: DecompositionPlan;
}

export function validateDecomposition(
  plan: DecompositionPlan,
  config: ValidateDecompositionConfig
): ValidateDecompositionResult {
  const errors: string[] = [];
  const warnings: string[] = [...(plan.warnings || [])];
  const maxSubTasks = config.maxSubTasks ?? 12;

  if (!plan.subtasks || !Array.isArray(plan.subtasks)) {
    return { ok: false, errors: ["plan.subtasks must be an array"] };
  }

  if (plan.subtasks.length > maxSubTasks) {
    errors.push(`Too many sub-tasks: ${plan.subtasks.length} exceeds maximum of ${maxSubTasks}`);
  }

  const ids = new Set<string>();
  for (const st of plan.subtasks) {
    try {
      assertSafeId(st.id);
    } catch (e) {
      errors.push(`Invalid sub-task id "${st.id}": ${(e as Error).message}`);
    }
    if (ids.has(st.id)) {
      errors.push(`Duplicate sub-task id: "${st.id}"`);
    }
    ids.add(st.id);

    if (!st.allowedPaths || st.allowedPaths.length === 0) {
      errors.push(`Sub-task "${st.id}" has empty allowedPaths`);
    } else {
      for (const p of st.allowedPaths) {
        if (p.startsWith("..") || p.startsWith("/")) {
          errors.push(`Sub-task "${st.id}" allowedPath "${p}" escapes the repo`);
        }
        if (isUnsafeForTargeting(p)) {
          errors.push(`Sub-task "${st.id}" allowedPath "${p}" is sensitive or generated`);
        }
      }
    }

    if (!config.checks.includes(st.checkName)) {
      errors.push(`Sub-task "${st.id}" uses unknown checkName "${st.checkName}"`);
    }

    const hasDeliverables = st.deliverables && st.deliverables.length > 0;
    if (!hasDeliverables && !st.testCommand) {
      errors.push(`Sub-task "${st.id}" is non-verifiable (needs deliverables or testCommand)`);
    }
  }

  for (const st of plan.subtasks) {
    for (const dep of st.dependsOn || []) {
      if (!ids.has(dep)) {
        errors.push(`Sub-task "${st.id}" depends on unknown id "${dep}"`);
      }
    }
  }

  if (errors.length === 0) {
    try {
      detectCycle(plan.subtasks);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  if (errors.length === 0) {
    // Check for overlapping allowedPaths between independent sub-tasks
    const changedByWorker: Record<string, string[]> = {};
    for (const st of plan.subtasks) {
      changedByWorker[st.id] = st.allowedPaths;
    }
    const conflicts = detectFileConflicts(changedByWorker);
    
    // Filter conflicts to only those between independent sub-tasks
    for (const conflict of conflicts) {
      if (!isDependent(plan.subtasks, conflict.a, conflict.b) && !isDependent(plan.subtasks, conflict.b, conflict.a)) {
        warnings.push(`Independent sub-tasks "${conflict.a}" and "${conflict.b}" have overlapping allowedPaths: ${conflict.paths.join(", ")}`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    plan: {
      ...plan,
      warnings
    }
  };
}

function isDependent(subtasks: SubTaskSpec[], a: string, b: string): boolean {
  // Returns true if a depends on b (transitively)
  const byId = new Map(subtasks.map(st => [st.id, st]));
  const visited = new Set<string>();
  
  function dfs(current: string): boolean {
    if (current === b) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const st = byId.get(current);
    if (!st) return false;
    for (const dep of st.dependsOn || []) {
      if (dfs(dep)) return true;
    }
    return false;
  }
  
  return dfs(a);
}

function detectCycle(subtasks: SubTaskSpec[]): void {
  const adj = new Map<string, string[]>();
  for (const st of subtasks) {
    adj.set(st.id, st.dependsOn || []);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const st of subtasks) color.set(st.id, WHITE);

  function dfs(node: string): void {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor) ?? WHITE;
      if (c === GRAY) {
        throw new Error(`Dependency cycle detected involving "${node}" and "${neighbor}"`);
      }
      if (c === WHITE) dfs(neighbor);
    }
    color.set(node, BLACK);
  }

  for (const st of subtasks) {
    if (color.get(st.id) === WHITE) dfs(st.id);
  }
}

export interface ProposeDecompositionDeps {
  generate: (task: string, ctx: any) => Promise<any>;
}

export async function proposeDecomposition(
  task: string,
  ctx: any,
  deps: ProposeDecompositionDeps,
  config: ValidateDecompositionConfig
): Promise<DecompositionPlan> {
  try {
    const raw = await deps.generate(task, ctx);
    const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
    
    const result = validateDecomposition(plan, config);
    if (result.ok && result.plan) {
      return result.plan;
    }
    
    // Fallback on validation error
    return fallbackToHeuristic(task, config, result.errors);
  } catch (e) {
    // Fallback on malformed JSON or generation error
    return fallbackToHeuristic(task, config, [(e as Error).message]);
  }
}

function fallbackToHeuristic(task: string, config: ValidateDecompositionConfig, errors: string[]): DecompositionPlan {
  const heuristicPlan = buildPlan(task, { checkNames: config.checks });
  
  const subtasks: SubTaskSpec[] = heuristicPlan.workers.map(w => ({
    id: w.id,
    title: w.title,
    goal: w.prompt,
    deliverables: [],
    allowedPaths: w.allowedPaths || [],
    testCommand: undefined,
    dependsOn: w.dependsOn || [],
    checkName: w.checkName || config.checks[0] || "phase"
  }));

  return {
    task,
    subtasks,
    source: "heuristic",
    warnings: [
      "Model decomposition failed, fell back to heuristic plan.",
      ...errors.map(e => `Error: ${e}`)
    ]
  };
}

/* ------------------------------------------------------------------ */
/*  Phase 9O.3 + 9O.4 — execution + assembly                          */
/*                                                                    */
/*  Runs a validated sub-task DAG in dependency order on a CUMULATIVE */
/*  base (each sub-task sees prior accepted patches), then assembles  */
/*  and runs the full no-regression check. The model never executes;  */
/*  this only orchestrates the injected, already-gated seams. A red    */
/*  assembly is reported, NEVER auto-applied (we never call apply).    */
/*  The DEFAULT seams (runWorker→verify→force wiring) land with the    */
/*  9O.5 CLI slice, where realRoot/provider/mainEntry are available;   */
/*  callers and tests inject them.                                    */
/* ------------------------------------------------------------------ */

export interface SubTaskRunResult {
  accepted: boolean;
  patch: string;
  reason?: string;
}

export interface RunDecompositionOptions {
  realRoot: string;
  signal: AbortSignal;
  /** Run ONE sub-task on the cumulative base → its accepted patch (or accepted:false + reason). */
  runSubTask?: (subtask: SubTaskSpec, cumulativePatch: string) => Promise<SubTaskRunResult>;
  /** Run the full configured check on the assembled tree (no-regression gate). */
  runAssemblyCheck?: (assembledPatch: string) => Promise<{ ok: boolean }>;
}

export interface DecompositionRunResult {
  ok: boolean;
  order: string[];
  subtasks: { id: string; accepted: boolean; reason?: string }[];
  assembledPatch: string;
  assemblyOk: boolean;
  warnings: string[];
}

/** Deterministic topological order by dependsOn (assumes validated/acyclic). */
export function topoOrder(subtasks: SubTaskSpec[]): SubTaskSpec[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const out: SubTaskSpec[] = [];
  const visit = (st: SubTaskSpec): void => {
    if (visited.has(st.id)) return;
    visited.add(st.id);
    for (const dep of st.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    out.push(st);
  };
  for (const st of subtasks) visit(st); // stable: declared order breaks ties
  return out;
}

function appendPatch(base: string, next: string): string {
  if (!next || !next.trim()) return base;
  if (!base) return next.endsWith("\n") ? next : next + "\n";
  return base + (base.endsWith("\n") ? "" : "\n") + next;
}

function requireSeam(name: string): never {
  throw new Error(
    `runDecomposition: no "${name}" provided. The default wiring lands in Phase 9O.5 (CLI); ` +
      `callers/tests must inject "${name}".`,
  );
}

/**
 * Execute a decomposition: each sub-task runs (verify-then-force, via the
 * injected seam) on the cumulative base in dependency order; a non-accepted
 * sub-task STOPS the run (dependents do not run) and is surfaced. After all are
 * accepted, the assembled patch runs the full check. Never mutates the real
 * repo and never auto-applies — returns the assembled patch + verdict.
 */
export async function runDecomposition(
  plan: DecompositionPlan,
  opts: RunDecompositionOptions,
): Promise<DecompositionRunResult> {
  const warnings: string[] = [...(plan.warnings ?? [])];
  const runSubTask = opts.runSubTask ?? (() => requireSeam("runSubTask"));
  const runAssemblyCheck = opts.runAssemblyCheck ?? (() => requireSeam("runAssemblyCheck"));

  const ordered = topoOrder(plan.subtasks);
  const order: string[] = [];
  const subtasks: { id: string; accepted: boolean; reason?: string }[] = [];

  let cumulativePatch = "";
  let allAccepted = true;

  for (const st of ordered) {
    order.push(st.id);
    const r = await runSubTask(st, cumulativePatch);
    subtasks.push({ id: st.id, accepted: r.accepted, reason: r.reason });
    if (!r.accepted) {
      allAccepted = false;
      warnings.push(
        `sub-task "${st.id}" not accepted (${r.reason ?? "verify/force failed"}) — stopping; dependents not run`,
      );
      break; // STOP — no silent continue past a failed sub-task
    }
    cumulativePatch = appendPatch(cumulativePatch, r.patch);
  }

  let assemblyOk = false;
  if (allAccepted) {
    const a = await runAssemblyCheck(cumulativePatch);
    assemblyOk = a.ok;
    if (!assemblyOk) {
      warnings.push("assembled patch failed the full check (regression) — NOT applied");
    }
  }

  return {
    ok: allAccepted && assemblyOk,
    order,
    subtasks,
    assembledPatch: cumulativePatch,
    assemblyOk,
    warnings,
  };
}
