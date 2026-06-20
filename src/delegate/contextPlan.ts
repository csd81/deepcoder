/**
 * Phase 9E — Context-aware delegation planner.
 *
 * `buildContextAwarePlan` builds a deterministic DelegationPlan (reusing
 * buildPlan from planner.ts) and then enriches it with a bounded, redacted
 * context brief from the explorer subagent.
 *
 * The explorer is INJECTABLE for testing — the default wraps runExplorer from
 * src/subagents/contextExplorer.js. The whole function is fail-closed: any
 * explorer failure yields the deterministic plan with NO contextBrief and
 * unmodified worker prompts.
 */

import { buildPlan } from "./planner.js";
import type { BuildPlanOptions } from "./planner.js";
import type { DelegationPlan } from "./types.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";
import type { ExplorerBrief } from "../context/explorerBrief.js";

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface ContextAwarePlanOptions extends BuildPlanOptions {
  /**
   * INJECTABLE explorer function. Default wraps runExplorer from
   * src/subagents/contextExplorer.js. Tests inject a fake.
   *
   * The function receives the task/question string and must return an object
   * with a `brief` field of type ExplorerBrief. It MUST NEVER throw — on any
   * error it should return a safe empty brief.
   */
  explore?: (question: string) => Promise<{ brief: ExplorerBrief }>;

  /** Maximum bytes for the rendered brief (default 6000). */
  maxBriefBytes?: number;
}

/* ------------------------------------------------------------------ */
/*  Default explorer wrapper                                           */
/* ------------------------------------------------------------------ */

/**
 * Default explore function wrapping the real runExplorer.
 * NEVER throws — on any error returns a safe empty brief.
 */
async function defaultExplore(question: string): Promise<{ brief: ExplorerBrief }> {
  try {
    const { runExplorer } = await import("../subagents/contextExplorer.js");
    const result = await runExplorer(question, {} as any);
    return { brief: result.brief };
  } catch {
    return {
      brief: {
        summary: "",
        relevantFiles: [],
        likelyFixLocations: [],
        relevantTests: [],
        risks: [],
        openQuestions: [],
        trace: [],
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/*  buildContextAwarePlan                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a DelegationPlan enriched with a context brief from the explorer.
 *
 * 1. Builds the base deterministic plan via buildPlan(task, opts).
 * 2. Calls explore(task) to get a brief (injectable; default wraps runExplorer).
 * 3. Renders the brief with renderExplorerBrief(brief, maxBriefBytes) — bounded
 *    and redacted.
 * 4. Sets plan.contextBrief = renderedBrief (the bounded string).
 * 5. Appends the rendered brief to EACH worker's prompt under a
 *    "## Context brief" heading.
 *
 * Fail-closed: any explorer failure yields the deterministic plan with NO
 * contextBrief and unmodified prompts.
 */
export async function buildContextAwarePlan(
  task: string,
  opts: ContextAwarePlanOptions = {},
): Promise<DelegationPlan> {
  // 1. Build the base deterministic plan.
  const plan = buildPlan(task, opts);

  // 2. Call explore to get a brief.
  const exploreFn = opts.explore ?? defaultExplore;
  const maxBriefBytes = opts.maxBriefBytes ?? 6000;

  let brief: ExplorerBrief;
  try {
    const result = await exploreFn(task);
    brief = result.brief;
  } catch {
    // Fail-closed: any explorer failure → return deterministic plan unchanged.
    return plan;
  }

  // 3. If the brief is effectively empty, fall back to the deterministic plan.
  if (!brief || (!brief.summary && brief.relevantFiles.length === 0 && brief.likelyFixLocations.length === 0)) {
    return plan;
  }

  // 4. Render the brief (bounded and redacted). renderExplorerBrief's bound is
  //    approximate (~maxBytes), so hard-cap to guarantee the brief can never
  //    exceed maxBriefBytes (and can't bloat worker prompts).
  const renderedBrief = renderExplorerBrief(brief, maxBriefBytes).slice(0, maxBriefBytes);

  // If rendering produced nothing usable, fall back.
  if (!renderedBrief || renderedBrief === "(empty brief)") {
    return plan;
  }

  // 5. Set plan.contextBrief.
  plan.contextBrief = renderedBrief;

  // 6. Append the rendered brief to each worker's prompt.
  const contextSection = `\n\n## Context brief\n${renderedBrief}`;
  for (const worker of plan.workers) {
    worker.prompt += contextSection;
  }

  return plan;
}
