/**
 * PlanBrief — a structured, dependency-aware implementation plan produced by
 * the architect subagent.
 *
 * Each step carries a stable id and a `dependsOn` list of prerequisite step
 * ids, forming a DAG. parsePlanBrief NEVER throws: on any parse failure it
 * returns a safe empty plan. It also enforces the DAG invariants defensively
 * (never trusting the model):
 *   - dangling `dependsOn` references are dropped (and noted in openQuestions)
 *   - self-dependencies are dropped
 *   - cycles are broken (and noted in openQuestions)
 *   - orderedSteps is returned in topological order
 *
 * renderPlanBrief returns a compact text representation bounded to ~6000 bytes.
 */

import type { SubagentTrace } from "../subagents/types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PlanStep {
  id: string;
  description: string;
  filesToTouch: string[];
  testsToAddOrRun: string[];
  rationale: string;
  /** ids of prerequisite steps (DAG edges). */
  dependsOn: string[];
}

export interface PlanBrief {
  summary: string;
  /** Steps in topological order (prerequisites first). */
  orderedSteps: PlanStep[];
  risks: string[];
  assumptions: string[];
  openQuestions: string[];
  trace: SubagentTrace[];
}

/**
 * A persisted record of an architect subagent run. Stored in session metadata
 * (session.plans) — NEVER added to the model-visible message history.
 */
export interface PlanRunRecord {
  createdAt: string;
  plan: PlanBrief;
  trace: SubagentTrace;
  /** Path the rendered plan was persisted to, if any. */
  planPath?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_STEPS = 30;
const MAX_PER_LIST = 10;
const MAX_ENTRY_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 500;
const DEFAULT_MAX_BYTES = 6000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? ""));
}

/** Dedupe an array of strings by lowercased value, trim, bound length. */
function cleanStrings(items: string[], maxLen: number, maxEntry: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = String(item).trim().slice(0, maxEntry);
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Dedupe SubagentTrace entries by a composite key. */
function cleanTraces(items: unknown[], maxLen: number): SubagentTrace[] {
  const seen = new Set<string>();
  const out: SubagentTrace[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const toolsCalled = asStringArray(raw.toolsCalled);
    const turns = Number(raw.turns) || 0;
    const model = String(raw.model ?? "").trim();
    const key = `${model}|${turns}|${toolsCalled.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ toolsCalled, turns, model });
    if (out.length >= maxLen) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Step extraction (ids + fields, deps left raw)                     */
/* ------------------------------------------------------------------ */

interface RawStep {
  step: PlanStep;
  rawDependsOn: string[];
}

/** Build steps with unique ids; description-less steps are dropped. */
function extractSteps(items: unknown[]): RawStep[] {
  const usedIds = new Set<string>();
  const out: RawStep[] = [];
  let autoCounter = 0;
  for (const item of items) {
    if (out.length >= MAX_STEPS) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const description = String(raw.description ?? "").trim().slice(0, MAX_ENTRY_LENGTH);
    if (description.length === 0) continue;

    let id = String(raw.id ?? "").trim().slice(0, MAX_ENTRY_LENGTH);
    if (id.length === 0 || usedIds.has(id)) {
      do {
        autoCounter += 1;
        id = `s${autoCounter}`;
      } while (usedIds.has(id));
    }
    usedIds.add(id);

    out.push({
      step: {
        id,
        description,
        filesToTouch: cleanStrings(asStringArray(raw.filesToTouch), MAX_PER_LIST, MAX_ENTRY_LENGTH),
        testsToAddOrRun: cleanStrings(asStringArray(raw.testsToAddOrRun), MAX_PER_LIST, MAX_ENTRY_LENGTH),
        rationale: String(raw.rationale ?? "").trim().slice(0, MAX_ENTRY_LENGTH),
        dependsOn: [],
      },
      rawDependsOn: asStringArray(raw.dependsOn),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  DAG validation                                                     */
/* ------------------------------------------------------------------ */

/** Kahn's algorithm; returns the placeable order and any nodes left in cycles. */
function kahnPartial(
  ids: string[],
  deps: Map<string, Set<string>>,
): { order: string[]; remaining: Set<string> } {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, deps.get(id)!.size);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const d of deps.get(id)!) dependents.get(d)!.push(id);
  }
  // Seed queue in input order for stable output among independent nodes.
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const dep of dependents.get(n)!) {
      indeg.set(dep, indeg.get(dep)! - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  const remaining = new Set<string>(ids.filter((id) => !order.includes(id)));
  return { order, remaining };
}

/**
 * Validate and order steps. Drops dangling/self dependencies, breaks cycles,
 * and returns the steps topologically sorted plus notes about what was changed.
 */
function validateDag(raws: RawStep[]): { steps: PlanStep[]; notes: string[] } {
  const notes: string[] = [];
  const ids = raws.map((r) => r.step.id);
  const idSet = new Set(ids);
  const byId = new Map(raws.map((r) => [r.step.id, r.step]));

  // Resolve dependsOn against real ids; drop dangling and self refs.
  const deps = new Map<string, Set<string>>();
  let droppedRef = false;
  for (const r of raws) {
    const set = new Set<string>();
    for (const dep of r.rawDependsOn) {
      const d = dep.trim();
      if (d.length === 0) continue;
      if (d === r.step.id) {
        droppedRef = true;
        continue;
      }
      if (!idSet.has(d)) {
        droppedRef = true;
        continue;
      }
      set.add(d);
    }
    deps.set(r.step.id, set);
  }
  if (droppedRef) {
    notes.push("One or more step dependencies referenced unknown or self steps and were dropped.");
  }

  // Break cycles: repeatedly remove an edge among remaining nodes until acyclic.
  let cycleBroken = false;
  let order: string[] = [];
  for (let guard = 0; guard <= ids.length + 1; guard++) {
    const res = kahnPartial(ids, deps);
    if (res.remaining.size === 0) {
      order = res.order;
      break;
    }
    cycleBroken = true;
    // Remove one edge participating in the remaining cycle.
    let removed = false;
    for (const id of ids) {
      if (!res.remaining.has(id)) continue;
      const set = deps.get(id)!;
      for (const d of set) {
        if (res.remaining.has(d)) {
          set.delete(d);
          removed = true;
          break;
        }
      }
      if (removed) break;
    }
    if (!removed) {
      // Safety net: append the rest in input order.
      order = [...res.order, ...ids.filter((id) => res.remaining.has(id))];
      break;
    }
  }
  if (order.length !== ids.length) {
    // Final safety: ensure every id appears exactly once, input order for any missing.
    const placed = new Set(order);
    for (const id of ids) if (!placed.has(id)) order.push(id);
  }
  if (cycleBroken) {
    notes.push("A dependency cycle was detected and broken; review the step ordering.");
  }

  // Write resolved deps back onto the steps and emit in topological order.
  const steps: PlanStep[] = [];
  for (const id of order) {
    const step = byId.get(id);
    if (!step) continue;
    step.dependsOn = [...deps.get(id)!];
    steps.push(step);
  }
  return { steps, notes };
}

/* ------------------------------------------------------------------ */
/*  Safe empty plan                                                    */
/* ------------------------------------------------------------------ */

function emptyPlan(): PlanBrief {
  return {
    summary: "",
    orderedSteps: [],
    risks: [],
    assumptions: [],
    openQuestions: [],
    trace: [],
  };
}

/* ------------------------------------------------------------------ */
/*  parsePlanBrief                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw JSON string into a PlanBrief.
 *
 * NEVER throws. On missing, empty, malformed JSON, or any parse error it
 * returns a safe empty plan. DAG invariants are enforced defensively.
 */
export function parsePlanBrief(raw: string): PlanBrief {
  if (!raw || typeof raw !== "string") return emptyPlan();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return emptyPlan();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptyPlan();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyPlan();
  const obj = parsed as Record<string, unknown>;

  const summary = String(obj.summary ?? "").trim().slice(0, MAX_SUMMARY_LENGTH);

  const raws = extractSteps(Array.isArray(obj.orderedSteps) ? obj.orderedSteps : []);
  const { steps: orderedSteps, notes } = validateDag(raws);

  const risks = cleanStrings(asStringArray(obj.risks), MAX_PER_LIST, MAX_ENTRY_LENGTH);
  const assumptions = cleanStrings(asStringArray(obj.assumptions), MAX_PER_LIST, MAX_ENTRY_LENGTH);
  const modelQuestions = cleanStrings(asStringArray(obj.openQuestions), MAX_PER_LIST, MAX_ENTRY_LENGTH);
  // Append validation notes after model questions (deduped).
  const openQuestions = cleanStrings([...modelQuestions, ...notes], MAX_PER_LIST + notes.length, MAX_ENTRY_LENGTH);

  const trace = cleanTraces(Array.isArray(obj.trace) ? obj.trace : [], 5);

  return { summary, orderedSteps, risks, assumptions, openQuestions, trace };
}

/* ------------------------------------------------------------------ */
/*  renderPlanBrief                                                    */
/* ------------------------------------------------------------------ */

/**
 * Render a PlanBrief into a compact text representation, bounded to ~maxBytes.
 */
export function renderPlanBrief(plan: PlanBrief, maxBytes: number = DEFAULT_MAX_BYTES): string {
  const parts: string[] = [];

  if (plan.summary) {
    parts.push(`Summary: ${plan.summary}`);
  }

  if (plan.orderedSteps.length > 0) {
    const lines = plan.orderedSteps.map((s, i) => {
      const dep = s.dependsOn.length > 0 ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
      const files = s.filesToTouch.length > 0 ? `\n      files: ${s.filesToTouch.join(", ")}` : "";
      const tests = s.testsToAddOrRun.length > 0 ? `\n      tests: ${s.testsToAddOrRun.join(", ")}` : "";
      const why = s.rationale ? `\n      why: ${s.rationale}` : "";
      return `  ${i + 1}. [${s.id}] ${s.description}${dep}${files}${tests}${why}`;
    });
    parts.push(`Steps (${plan.orderedSteps.length}):\n${lines.join("\n")}`);
  }

  if (plan.risks.length > 0) {
    parts.push(`Risks (${plan.risks.length}):\n${plan.risks.map((r) => `  - ${r}`).join("\n")}`);
  }

  if (plan.assumptions.length > 0) {
    parts.push(`Assumptions (${plan.assumptions.length}):\n${plan.assumptions.map((a) => `  - ${a}`).join("\n")}`);
  }

  if (plan.openQuestions.length > 0) {
    parts.push(`Open questions (${plan.openQuestions.length}):\n${plan.openQuestions.map((q) => `  - ${q}`).join("\n")}`);
  }

  if (plan.trace.length > 0) {
    const lines = plan.trace.map(
      (t) => `  - model=${t.model}, turns=${t.turns}, tools=[${t.toolsCalled.join(", ")}]`,
    );
    parts.push(`Trace (${plan.trace.length}):\n${lines.join("\n")}`);
  }

  let result = parts.join("\n\n");

  if (result.length > maxBytes) {
    result = result.slice(0, maxBytes);
    const lastNewline = result.lastIndexOf("\n");
    if (lastNewline > maxBytes * 0.8) {
      result = result.slice(0, lastNewline);
    }
    result += "\n… (truncated)";
  }

  return result || "(empty plan)";
}
