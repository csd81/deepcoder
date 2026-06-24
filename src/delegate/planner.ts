/**
 * Phase 9A — Deterministic, pure planner.
 *
 * `buildPlan` splits a task string into 1-5 worker tasks based on file
 * boundaries inferred from the task text. No model calls, no I/O, no
 * randomness beyond an id derived from a timestamp.
 *
 * If safe file boundaries cannot be inferred, produces exactly ONE
 * conservative worker task (does not over-split).
 *
 * Dependency cycles are detected and rejected (throws) — the safe
 * deterministic option.
 */

import type { DelegationPlan, WorkerTask } from "./types.js";
import { existsSync } from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface BuildPlanOptions {
  /** Names of configured checks (e.g. ["typecheck", "lint"]). */
  checkNames?: string[];
  /** Workspace-relative paths of files changed so far (may be empty). */
  changedFiles?: string[];
  /** Maximum number of worker tasks (1-5, default 5). */
  maxWorkers?: number;
  tdd?: boolean;
  /**
   * Acceptance-first posture: force every worker TDD-required AND require a
   * production change (rejects test-only fixes). Implies `tdd`.
   */
  acceptanceFirst?: boolean;
  /**
   * Repo root path. When provided, inferred areas are validated against real
   * paths under the repo — only areas that map to existing `src/<area>` dirs
   * (or files named in the task) count toward multi-worker splitting.
   * Omitted → conservative: produce exactly 1 worker (no over-splitting).
   */
  root?: string;
}

/* ------------------------------------------------------------------ */
/*  buildPlan                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build a DelegationPlan from a task string. Deterministic and pure — no
 * model calls, no I/O, no randomness beyond the plan id (derived from a
 * timestamp).
 *
 * Splits the task into 1-5 worker tasks. Prefers sequential tasks unless
 * the task text clearly references disjoint file areas. If safe boundaries
 * cannot be inferred, produces exactly ONE conservative worker.
 *
 * Dependency cycles are detected and rejected with an error.
 */
export function buildPlan(task: string, opts: BuildPlanOptions = {}): DelegationPlan {
  const checkNames = opts.checkNames ?? [];
  const changedFiles = opts.changedFiles ?? [];
  const maxWorkers = Math.max(1, Math.min(5, opts.maxWorkers ?? 5));

  const id = newPlanId();
  const createdAt = new Date().toISOString();
  const taskTrimmed = task.trim();

  // Extract meaningful terms from the task to infer file boundaries.
  const terms = extractTerms(taskTrimmed);

  // Infer file areas from the task text, then filter to only real paths
  // when the repo root is known. Without a root, never over-split.
  const rawAreas = inferAreas(terms);
  const areas = opts.root
    ? rawAreas.filter((a) => areaExists(opts.root!, a, taskTrimmed))
    : [];

  // Decide how many workers to create.
  const workerCount = areas.length >= 2 && areas.length <= maxWorkers ? areas.length : 1;

  const workers: WorkerTask[] = [];
  const dependencies: { before: string; after: string; reason: string }[] = [];

  if (workerCount === 1) {
    // Conservative single worker — no over-splitting.
    workers.push(buildWorker(taskTrimmed, terms, changedFiles, checkNames, 1, workerCount));
  } else {
    // Multiple workers, one per inferred area.
    for (let i = 0; i < workerCount; i++) {
      const area = areas[i]!;
      const workerTask = buildWorkerForArea(taskTrimmed, area, terms, changedFiles, checkNames, i + 1, workerCount);
      workers.push(workerTask);
    }

    // Sequential dependencies: worker i depends on worker i-1.
    for (let i = 1; i < workers.length; i++) {
      dependencies.push({
        before: workers[i - 1]!.id,
        after: workers[i]!.id,
        reason: `Sequential: "${workers[i - 1]!.title}" must complete before "${workers[i]!.title}"`,
      });
    }
  }

  // Detect dependency cycles (should not happen with our sequential chain,
  // but guard against future changes).
  detectCycle(workers, dependencies);

  if (opts.tdd || opts.acceptanceFirst) {
    for (const w of workers) {
      w.tdd = { required: true, allowedTestPaths: ["test/", "tests/"] };
      // Acceptance-first additionally forbids a test-only fix.
      if (opts.acceptanceFirst) w.requireProductionChange = true;
    }
  }

  const riskNotes: string[] = [];
  if (workerCount === 1 && areas.length > 1) {
    riskNotes.push(
      `Task mentions ${areas.length} distinct areas but safe boundaries could not be inferred; collapsed into 1 worker.`,
    );
  }
  if (changedFiles.length > 0) {
    riskNotes.push(`${changedFiles.length} file(s) already changed — verify no regressions.`);
  }
  if (checkNames.length === 0) {
    riskNotes.push("No checks configured — worker tasks will have no check assigned.");
  }
  riskNotes.push("Review each worker's allowedPaths before approving execution.");

  return {
    id,
    task: taskTrimmed,
    createdAt,
    status: "planned",
    workers,
    dependencies,
    globalChecks: checkNames.slice(),
    riskNotes,
  };
}

/* ------------------------------------------------------------------ */
/*  Worker construction                                                */
/* ------------------------------------------------------------------ */

function buildWorker(
  task: string,
  terms: string[],
  changedFiles: string[],
  checkNames: string[],
  index: number,
  total: number,
): WorkerTask {
  const id = `worker-${index}`;
  const title = total === 1 ? task.slice(0, 80) : `Part ${index}: ${task.slice(0, 60)}`;
  const allowedPaths = changedFiles.length > 0 ? [...changedFiles] : ["src"];
  const forbiddenPaths = ["node_modules", ".deepcoder"];

  return {
    id,
    title,
    prompt: task,
    allowedPaths,
    forbiddenPaths,
    checkName: checkNames[0] ?? "phase",
    maxAttempts: 3,
    dependsOn: [],
    expectedOutputs: terms.length > 0 ? terms.slice(0, 5) : ["Complete the task"],
    status: "planned",
  };
}

function buildWorkerForArea(
  task: string,
  area: string,
  terms: string[],
  changedFiles: string[],
  checkNames: string[],
  index: number,
  _total: number,
): WorkerTask {
  const id = `worker-${index}`;
  const title = `Implement ${area}`;
  const allowedPaths = [area, ...changedFiles.filter((f) => f.startsWith(area))];
  const forbiddenPaths = ["node_modules", ".deepcoder"];

  return {
    id,
    title,
    prompt: `${task}\n\nFocus on the "${area}" area.`,
    allowedPaths: [...new Set(allowedPaths)],
    forbiddenPaths,
    checkName: checkNames[index - 1] ?? checkNames[0] ?? "phase",
    maxAttempts: 3,
    dependsOn: index > 1 ? [`worker-${index - 1}`] : [],
    expectedOutputs: terms.length > 0 ? terms.slice(0, 5) : [`Changes in ${area}`],
    status: "planned",
  };
}

/* ------------------------------------------------------------------ */
/*  Cycle detection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Detect dependency cycles in the worker graph. Throws if a cycle is found.
 * Uses DFS-based cycle detection. This is the safe deterministic option:
 * fail closed rather than silently dropping edges.
 */
function detectCycle(
  workers: WorkerTask[],
  dependencies: { before: string; after: string; reason: string }[],
): void {
  const workerIds = new Set(workers.map((w) => w.id));

  // Build adjacency list: worker id -> list of worker ids that depend on it
  const adj = new Map<string, string[]>();
  for (const w of workers) {
    adj.set(w.id, []);
  }
  for (const dep of dependencies) {
    if (!workerIds.has(dep.before) || !workerIds.has(dep.after)) continue;
    // dep.before must complete before dep.after can start
    // So dep.after depends on dep.before
    const list = adj.get(dep.after);
    if (list) list.push(dep.before);
  }

  // Also check dependsOn fields on workers
  for (const w of workers) {
    for (const depId of w.dependsOn) {
      if (!workerIds.has(depId)) continue;
      const list = adj.get(w.id);
      if (list && !list.includes(depId)) list.push(depId);
    }
  }

  // DFS cycle detection
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of workerIds) color.set(id, WHITE);

  function dfs(node: string): void {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor) ?? WHITE;
      if (c === GRAY) {
        throw new Error(
          `Dependency cycle detected involving worker "${node}" and "${neighbor}". ` +
            "Fail-closed: remove the cycle and re-plan.",
        );
      }
      if (c === WHITE) dfs(neighbor);
    }
    color.set(node, BLACK);
  }

  for (const id of workerIds) {
    if (color.get(id) === WHITE) dfs(id);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Generate a deterministic plan id from the current timestamp. */
function newPlanId(): string {
  return `plan-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** Extract meaningful terms from a task string (lowercased, deduped). */
function extractTerms(task: string): string[] {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Infer file-system areas from task terms. Looks for terms that look like
 * paths or module names (e.g. "auth", "database", "ui"). Returns a
 * deduplicated, bounded list of area names.
 */
function inferAreas(terms: string[]): string[] {
  const areaSet = new Set<string>();

  for (const term of terms) {
    // Skip generic terms that don't map to file areas.
    if (GENERIC_TERMS.has(term)) continue;

    // Treat the term as a potential area if it looks like a module/directory name.
    if (/^[a-z][a-z0-9_-]*$/.test(term) && term.length >= 2) {
      areaSet.add(term);
    }
  }

  // Limit to a reasonable number of areas.
  const areas = [...areaSet].slice(0, 5);

  // If no areas were inferred, return an empty list (caller will use 1 worker).
  return areas;
}

/**
 * Check whether an inferred area term maps to a real path under the repo root.
 * An area is "real" if `src/<area>` exists as a directory, or if the task text
 * names a file path whose directory components contain the area term (e.g. task
 * mentions `src/util/strings.ts` → "util" and "strings" are real for that file).
 */
function areaExists(root: string, area: string, task: string): boolean {
  // 1. Check if src/<area> directory exists.
  if (existsSync(path.join(root, "src", area))) return true;

  // 2. Check if the task mentions a file path containing the area term as a
  //    path component (e.g. "src/util/strings.ts" → "util" is a component).
  const pathPattern = /[a-z][a-z0-9_/-]*\.[a-z]{1,6}/gi;
  let m: RegExpExecArray | null;
  while ((m = pathPattern.exec(task)) !== null) {
    const filePath = m[0];
    const parts = filePath.split("/");
    if (parts.includes(area)) return true;
  }

  return false;
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "will",
  "what",
  "when",
  "where",
  "which",
  "their",
  "there",
  "about",
  "would",
  "could",
  "should",
  "into",
  "over",
  "such",
  "only",
  "than",
  "then",
  "also",
  "very",
  "just",
  "more",
  "some",
  "them",
  "than",
  "well",
  "make",
  "like",
  "even",
  "back",
  "after",
  "before",
  "still",
  "much",
  "down",
  "most",
  "each",
  "other",
  "many",
  "does",
  "done",
  "need",
  "find",
  "tell",
  "work",
  "part",
  "take",
  "come",
  "made",
  "used",
  "must",
  "file",
  "code",
  "task",
  "test",
  "implement",
  "create",
  "update",
  "remove",
  "change",
  "modify",
  "delete",
  "refactor",
  "fix",
  "add",
  "ensure",
  "allow",
  "using",
  "based",
  "need",
  "make",
  "sure",
  "check",
  "verify",
  "ensure",
  "should",
  "would",
  "could",
]);

const GENERIC_TERMS = new Set([
  "implement",
  "create",
  "update",
  "remove",
  "change",
  "modify",
  "delete",
  "refactor",
  "fix",
  "add",
  "feature",
  "function",
  "feature",
  "module",
  "component",
  "system",
  "project",
  "thing",
  "stuff",
  "item",
  "logic",
  "support",
  "handle",
  "process",
  "manage",
  "config",
  "setup",
  "cleanup",
  "improve",
  "optimize",
  "simplify",
  "extract",
  "inline",
  "rename",
  "move",
  "copy",
]);
