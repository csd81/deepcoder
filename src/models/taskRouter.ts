/**
 * Phase 10F2 — Task Router Policy Layer (deterministic core).
 *
 * Pure functions that classify a task's complexity/risk and apply a policy
 * to select a model role. NO model calls, NO I/O, NO secrets in output.
 */

import type {
  ModelRole,
  ResolvedModelRoute,
  TaskComplexity,
  TaskRisk,
  TaskRouteRequest,
  TaskRouteDecision,
  TaskRouterPolicy,
} from "./types.js";
import type { ModelRouter } from "./router.js";

// ─────────────────────────────────────────────────────────
// Keyword set that marks a task as hard (case-insensitive match).
// ─────────────────────────────────────────────────────────
const HARD_KEYWORDS = new Set([
  "refactor",
  "security",
  "architecture",
  "race",
  "migration",
  "multi-file",
  "swe-bench",
  "benchmark",
  "sandbox",
  "permission",
]);

/**
 * Count how many of the hard keywords appear in `text`.
 * Used as part of the complexity heuristic.
 */
function countHardKeywords(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of HARD_KEYWORDS) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

/**
 * Classify a task's complexity and risk using purely deterministic rules.
 *
 * Rules (in evaluation order):
 *   1. safety-sensitive → hard / high
 *   2. mutating + ≥3 expected files OR ≥2 hard keywords → hard / high
 *   3. read-only + short prompt (≤200 chars) → simple / low
 *   4. mutating → normal / medium (never below normal — rule 6)
 *   5. ≥3 expected files OR ≥1 hard keyword → hard / medium
 *   6. otherwise → normal / medium
 *
 * @returns `{ complexity, risk, reason }` with human-readable explanation bullets.
 */
export function classifyComplexity(
  req: TaskRouteRequest,
): { complexity: TaskComplexity; risk: TaskRisk; reason: string[] } {
  const reason: string[] = [];
  const prompt = req.prompt ?? "";

  const kwCount = countHardKeywords(prompt);
  const multiFile = (req.expectedFiles?.length ?? 0) >= 3;

  // Rule 1: safety-sensitive → always hard / high.
  if (req.safetySensitive) {
    reason.push("safety-sensitive: classified as hard / high");
    return { complexity: "hard", risk: "high", reason };
  }

  // Rule 2: any hard signal (multi-file ≥3 OR a hard keyword) → hard / high.
  // Evaluated BEFORE the read-only-simple shortcut so a short read-only prompt
  // that mentions e.g. "security"/"sandbox"/"migration" is still hard.
  if (multiFile || kwCount >= 1) {
    if (multiFile) reason.push("multi-file task (≥3 expected files): classified as hard");
    if (kwCount >= 1) reason.push(`prompt contains ${kwCount} hard keyword(s): classified as hard`);
    return { complexity: "hard", risk: "high", reason };
  }

  // Rule 3: read-only + short prompt with no hard signal → simple / low.
  if (req.readonly && prompt.length <= 200) {
    reason.push("read-only short prompt: classified as simple / low");
    return { complexity: "simple", risk: "low", reason };
  }

  // Rule 4: mutating → normal / medium (never below normal).
  if (req.mutating) {
    reason.push("mutating task: classified as normal / medium");
    return { complexity: "normal", risk: "medium", reason };
  }

  // Rule 5: everything else → normal / medium.
  reason.push("default: classified as normal / medium");
  return { complexity: "normal", risk: "medium", reason };
}

// ─────────────────────────────────────────────────────────
// Options for decideRoute
// ─────────────────────────────────────────────────────────
export interface TaskRouterOpts {
  /** The policy configuration (from file config or in-memory overrides). */
  policy?: TaskRouterPolicy;
  /** Optional ModelRouter to resolve the selected role to a ResolvedModelRoute. */
  router?: ModelRouter;
}

/**
 * Subset of read-only roles that are "weak" — purely info-gathering roles
 * that MUST NOT handle mutating tasks even via explicit policy.
 *
 * "plan" and "review" are analytical/reasoning roles legitimately used for
 * planning hard tasks or reviewing safety-sensitive ones (per spec examples).
 * "qualityGate" is a meta-evaluation role.
 */
const WEAK_READONLY_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>([
  "research",
  "summarize",
  "triage",
  "explore",
]);

/**
 * Decide a route for a task request, applying the policy layer when enabled.
 *
 * Policy disabled (default):
 *   selectedRole = requestedRole (byte-identical routing).
 *
 * Policy enabled:
 *   - safety-sensitive → safetyRole (or requestedRole if unset)
 *   - read-only + simple → readOnlySimpleRole → simpleRole → requestedRole
 *   - mutating + normal → normalRole (or requestedRole if unset)
 *   - hard → hardRole (or requestedRole if unset)
 *
 * Safety invariants:
 *   - A mutating task MUST NOT route to a weak info-gathering role
 *     (research/summarize/triage/explore) regardless of policy.
 *   - Unknown/malformed policy values → fail closed to requestedRole.
 *   - NO API keys, raw provider keys, or full prompt text in output.
 *
 * @returns A fully populated TaskRouteDecision.
 */
export function decideRoute(
  req: TaskRouteRequest,
  opts: TaskRouterOpts,
): TaskRouteDecision {
  const classification = classifyComplexity(req);
  const reason: string[] = [...classification.reason];
  const policy = opts.policy;
  const enabled = policy?.enabled === true;

  let selectedRole: ModelRole = req.role;

  if (enabled && policy) {
    // Safety-sensitive → safetyRole
    if (req.safetySensitive) {
      const mapped = policy.safetyRole;
      if (mapped && isValidRole(mapped)) {
        if (isWeakReadOnly(mapped) && req.mutating) {
          reason.push(`safetyRole "${mapped}" is a weak read-only role but task is mutating: keeping requested role "${req.role}"`);
        } else {
          selectedRole = mapped;
          reason.push(`policy enabled + safety-sensitive: selected role "${mapped}"`);
        }
      } else {
        reason.push(`safetyRole not configured or invalid: keeping requested role "${req.role}"`);
      }
    }
    // Read-only simple → readOnlySimpleRole / simpleRole
    else if (req.readonly && classification.complexity === "simple") {
      const mapped = policy.readOnlySimpleRole ?? policy.simpleRole;
      if (mapped && isValidRole(mapped)) {
        selectedRole = mapped;
        reason.push(`policy enabled + read-only simple: selected role "${mapped}"`);
      } else {
        reason.push(`simple role not configured or invalid: keeping requested role "${req.role}"`);
      }
    }
    // Normal mutating → normalRole
    else if (req.mutating && classification.complexity === "normal") {
      const mapped = policy.normalRole;
      if (mapped && isValidRole(mapped)) {
        if (isWeakReadOnly(mapped)) {
          reason.push(`normalRole "${mapped}" is a weak read-only role but task is mutating: keeping requested role "${req.role}"`);
        } else {
          selectedRole = mapped;
          reason.push(`policy enabled + normal mutating: selected role "${mapped}"`);
        }
      } else {
        reason.push(`normalRole not configured or invalid: keeping requested role "${req.role}"`);
      }
    }
    // Hard → hardRole
    else if (classification.complexity === "hard") {
      const mapped = policy.hardRole;
      if (mapped && isValidRole(mapped)) {
        if (isWeakReadOnly(mapped) && req.mutating) {
          reason.push(`hardRole "${mapped}" is a weak read-only role but task is mutating: keeping requested role "${req.role}"`);
        } else {
          selectedRole = mapped;
          reason.push(`policy enabled + hard task: selected role "${mapped}"`);
        }
      } else {
        reason.push(`hardRole not configured or invalid: keeping requested role "${req.role}"`);
      }
    }
  }

  if (!enabled || selectedRole === req.role) {
    if (!enabled) reason.push("policy disabled: byte-identical routing (selectedRole = requestedRole)");
  }

  // Resolve the selected role to a full ResolvedModelRoute
  let route: ResolvedModelRoute;
  if (opts.router) {
    route = opts.router.resolve(selectedRole);
  } else {
    route = {
      role: selectedRole,
      provider: "",
      model: "",
      baseUrl: "",
      source: "default",
    };
  }

  return {
    requestedRole: req.role,
    selectedRole,
    complexity: classification.complexity,
    risk: classification.risk,
    route,
    reason,
  };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const ALL_ROLE_NAMES: ReadonlySet<string> = new Set<string>([
  "edit",
  "plan",
  "review",
  "research",
  "summarize",
  "triage",
  "explore",
  "delegate",
  "qualityGate",
  "fallback",
]);

function isValidRole(role: string): role is ModelRole {
  return ALL_ROLE_NAMES.has(role);
}

function isWeakReadOnly(role: ModelRole): boolean {
  return WEAK_READONLY_ROLES.has(role);
}
