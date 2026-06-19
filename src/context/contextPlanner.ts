/**
 * ContextPlanner — a pure deterministic + optional model-assisted planner.
 *
 * `buildDeterministicPlan` derives a ContextPlan from the task text, the repo
 * index, configured check names, and changed files. It never throws.
 *
 * `planContext` accepts an optional model hook (async function returning JSON
 * text) and falls back to the deterministic plan when the JSON is missing,
 * malformed, or fails isContextPlan.
 */

import type { RepoIndex } from "../index/types.js";
import { isContextPlan, clampPlan } from "./contextPlan.js";
import type { ContextPlan } from "./contextPlan.js";

/* ------------------------------------------------------------------ */
/*  Input types                                                        */
/* ------------------------------------------------------------------ */

export interface PlannerInputs {
  /** The user's task description. */
  task: string;
  /** The current repo index (may be empty/minimal). */
  index: RepoIndex;
  /** Names of configured checks (e.g. ["typecheck", "lint"]). */
  checkNames: string[];
  /** Workspace-relative paths of files changed so far (may be empty). */
  changedFiles: string[];
}

export interface PlanContextOptions {
  /** The user's task description. */
  task: string;
  /** The current repo index. */
  index: RepoIndex;
  /** Names of configured checks. */
  checkNames: string[];
  /** Workspace-relative paths of files changed so far. */
  changedFiles: string[];
  /**
   * Optional async hook that returns JSON text for a model-assisted plan.
   * When absent or when the result is invalid, the deterministic plan is used.
   */
  modelHook?: () => Promise<string>;
}

/* ------------------------------------------------------------------ */
/*  Deterministic planner                                              */
/* ------------------------------------------------------------------ */

/**
 * Pure deterministic plan derived from the task text, repo index, check names,
 * and changed files. Every output list is bounded and deduped. Never throws.
 */
export function buildDeterministicPlan(inputs: PlannerInputs): ContextPlan {
  const { task, index, checkNames, changedFiles } = inputs;

  // --- taskSummary ---
  const taskSummary = task.trim().slice(0, 200) || "(empty task)";

  // --- likelyAreas: directories from changed files + index file paths ---
  const areaSet = new Set<string>();
  for (const f of changedFiles) {
    const dir = dirname(f);
    if (dir) areaSet.add(dir);
  }
  // Add top-level src/ directories from the index
  for (const f of index.files) {
    const top = f.path.split("/")[0];
    if (top && !top.startsWith(".")) areaSet.add(top);
    if (areaSet.size >= 20) break;
  }
  const likelyAreas = [...areaSet].sort().slice(0, 20);

  // --- initialQueries: grep-friendly terms from the task ---
  const queryTerms = extractTerms(task);
  const initialQueries = queryTerms.slice(0, 20);

  // --- mustRead: changed files + code files matching task terms ---
  const mustReadSet = new Set(changedFiles);
  const taskWords = new Set(
    task
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((w) => w.length >= 4),
  );
  for (const f of index.files) {
    if (mustReadSet.size >= 20) break;
    if (f.kind !== "code" && f.kind !== "test") continue;
    const base = basename(f.path).toLowerCase().replace(/\.[^.]+$/, "");
    if (wordMatch(base, taskWords)) mustReadSet.add(f.path);
  }
  const mustRead = [...mustReadSet].sort().slice(0, 20);

  // --- likelySymbols: symbols from index whose name overlaps with task ---
  const symbolSet = new Set<string>();
  for (const s of index.symbols) {
    if (symbolSet.size >= 20) break;
    const name = s.name.toLowerCase();
    for (const w of taskWords) {
      if (name.includes(w) || w.includes(name)) {
        symbolSet.add(s.name);
        break;
      }
    }
  }
  const likelySymbols = [...symbolSet].sort().slice(0, 20);

  // --- likelyChecks ---
  const likelyChecks = checkNames.slice(0, 20);

  // --- riskNotes ---
  const riskNotes: string[] = [];
  if (changedFiles.length > 0) {
    riskNotes.push(`${changedFiles.length} file(s) already changed — verify no regressions.`);
  }
  if (index.files.length === 0) {
    riskNotes.push("Repo index is empty — exploration may be less informed.");
  }
  if (taskWords.size === 0) {
    riskNotes.push("Task text is very short — consider clarifying.");
  }
  riskNotes.push("Always verify by reading files before editing.");

  // --- stopConditions ---
  const stopConditions: string[] = [
    "All must-read files have been read.",
    "Key symbols have been located in the codebase.",
    "Relevant tests have been identified.",
    "Risks have been assessed.",
  ];

  const plan: ContextPlan = {
    taskSummary,
    likelyAreas,
    initialQueries,
    mustRead,
    likelySymbols,
    likelyChecks,
    riskNotes,
    stopConditions,
  };

  return clampPlan(plan);
}

/* ------------------------------------------------------------------ */
/*  planContext — model-assisted with deterministic fallback            */
/* ------------------------------------------------------------------ */

/**
 * Produce a ContextPlan using an optional model hook. When the hook is absent,
 * returns undefined JSON, malformed JSON, or JSON that fails isContextPlan,
 * the deterministic plan is returned instead. Never throws.
 */
export async function planContext(opts: PlanContextOptions): Promise<ContextPlan> {
  const deterministic = buildDeterministicPlan({
    task: opts.task,
    index: opts.index,
    checkNames: opts.checkNames,
    changedFiles: opts.changedFiles,
  });

  if (!opts.modelHook) return deterministic;

  try {
    const raw = await opts.modelHook();
    if (!raw || raw.trim().length === 0) return deterministic;

    const parsed = JSON.parse(raw) as unknown;
    if (!isContextPlan(parsed)) return deterministic;

    // Merge: use model fields where present, fall back to deterministic for
    // missing array items (though isContextPlan guarantees all fields exist).
    const merged: ContextPlan = {
      taskSummary: parsed.taskSummary || deterministic.taskSummary,
      likelyAreas: parsed.likelyAreas.length ? parsed.likelyAreas : deterministic.likelyAreas,
      initialQueries: parsed.initialQueries.length ? parsed.initialQueries : deterministic.initialQueries,
      mustRead: parsed.mustRead.length ? parsed.mustRead : deterministic.mustRead,
      likelySymbols: parsed.likelySymbols.length ? parsed.likelySymbols : deterministic.likelySymbols,
      likelyChecks: parsed.likelyChecks.length ? parsed.likelyChecks : deterministic.likelyChecks,
      riskNotes: parsed.riskNotes.length ? parsed.riskNotes : deterministic.riskNotes,
      stopConditions: parsed.stopConditions.length ? parsed.stopConditions : deterministic.stopConditions,
    };

    return clampPlan(merged);
  } catch {
    // JSON parse error or any other exception → deterministic fallback
    return deterministic;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Get the directory portion of a POSIX path, or "" for a bare name. */
function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

/** Get the file name portion of a POSIX path. */
function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
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

/** Check if a file stem (lowercased, no ext) overlaps with any task word. */
function wordMatch(stem: string, taskWords: Set<string>): boolean {
  for (const w of taskWords) {
    if (stem.includes(w) || w.includes(stem)) return true;
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
]);
