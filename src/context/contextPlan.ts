/**
 * ContextPlan — a bounded, inspectable plan for gathering context before
 * implementation. Produced by the context planner (deterministic or model-
 * assisted) and consumed by the explorer subagent.
 *
 * Every string[] field is bounded and deduped by clampPlan().
 */

export interface ContextPlan {
  /** Short summary of the user's task. */
  taskSummary: string;
  /** Likely areas/directories of the codebase to explore. */
  likelyAreas: string[];
  /** Initial search/grep queries to run. */
  initialQueries: string[];
  /** Files that must be read before implementation. */
  mustRead: string[];
  /** Symbol names likely relevant to the task. */
  likelySymbols: string[];
  /** Check/validation names likely relevant. */
  likelyChecks: string[];
  /** Risks or pitfalls to watch for. */
  riskNotes: string[];
  /** Conditions under which exploration should stop. */
  stopConditions: string[];
}

/** The list-valued (string[]) fields of a ContextPlan. */
type ContextPlanListField =
  | "likelyAreas"
  | "initialQueries"
  | "mustRead"
  | "likelySymbols"
  | "likelyChecks"
  | "riskNotes"
  | "stopConditions";

/** Default maximum length for each string[] field after clamping. */
const DEFAULT_MAX_PER_LIST = 20;

/** Default maximum string length per entry. */
const DEFAULT_MAX_ENTRY_LENGTH = 200;

/**
 * Type guard: returns true if `value` is a valid ContextPlan with all required
 * fields of the correct shape. Does not mutate.
 */
export function isContextPlan(value: unknown): value is ContextPlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.taskSummary !== "string") return false;
  const arrayFields: ContextPlanListField[] = [
    "likelyAreas",
    "initialQueries",
    "mustRead",
    "likelySymbols",
    "likelyChecks",
    "riskNotes",
    "stopConditions",
  ];
  for (const field of arrayFields) {
    if (!Array.isArray(v[field])) return false;
    for (const item of v[field] as unknown[]) {
      if (typeof item !== "string") return false;
    }
  }
  return true;
}

/**
 * Clamp (bound and dedupe) every string[] field of a ContextPlan in place.
 * Also trims whitespace and drops empty strings. Returns the same object for
 * convenience.
 */
export function clampPlan(
  plan: ContextPlan,
  opts: { maxPerList?: number; maxEntryLength?: number } = {},
): ContextPlan {
  const maxPerList = opts.maxPerList ?? DEFAULT_MAX_PER_LIST;
  const maxEntryLength = opts.maxEntryLength ?? DEFAULT_MAX_ENTRY_LENGTH;

  const arrayFields: ContextPlanListField[] = [
    "likelyAreas",
    "initialQueries",
    "mustRead",
    "likelySymbols",
    "likelyChecks",
    "riskNotes",
    "stopConditions",
  ];

  for (const field of arrayFields) {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const item of plan[field]) {
      const trimmed = item.trim().slice(0, maxEntryLength);
      if (trimmed.length === 0) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      cleaned.push(trimmed);
      if (cleaned.length >= maxPerList) break;
    }
    plan[field] = cleaned;
  }

  // Also bound taskSummary
  plan.taskSummary = plan.taskSummary.trim().slice(0, maxEntryLength);

  return plan;
}
