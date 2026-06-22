/**
 * Phase 10L — Session-local model route overrides.
 *
 * Pure functions for managing in-memory model/effort overrides that apply for
 * the duration of a session. No I/O, no config-file writes, no API calls.
 */

import type { ModelRole } from "./types.js";
import { ALL_ROLES } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionModelOverride {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface SessionModelOverrides {
  roles: Partial<Record<ModelRole, SessionModelOverride>>;
  defaultReasoningEffort?: "low" | "medium" | "high";
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_EFFORTS = new Set(["low", "medium", "high"]);
/** Max length for a provider or model string. */
const MAX_MODEL_STR_LEN = 200;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if a string contains ASCII control characters (0x00-0x1F, 0x7F).
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create an empty/clean session override state.
 */
export function emptySessionModelOverrides(): SessionModelOverrides {
  return { roles: {} };
}

/**
 * Parse a user-provided model target into optional provider + required model.
 *
 * Accepts:
 *   - "provider/model" → { provider: "provider", model: "model" }
 *   - "model-only"    → { model: "model-only" }
 *
 * Throws if the string is empty, too long, or contains control characters.
 */
export function parseModelTarget(input: string): { provider?: string; model: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Model target cannot be empty");
  if (trimmed.length > MAX_MODEL_STR_LEN) {
    throw new Error(`Model target too long (max ${MAX_MODEL_STR_LEN} characters)`);
  }
  if (hasControlChars(trimmed)) {
    throw new Error("Model target contains control characters");
  }

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    return { model: trimmed };
  }
  const provider = trimmed.slice(0, slashIdx).trim();
  const model = trimmed.slice(slashIdx + 1).trim();
  if (!provider) throw new Error("Provider prefix cannot be empty when using provider/model format");
  if (!model) throw new Error("Model name cannot be empty");
  return { provider, model };
}

/**
 * Validate that a role name is one of the known ALL_ROLES.
 */
export function isValidRole(role: string): role is ModelRole {
  return (ALL_ROLES as readonly string[]).includes(role);
}

/**
 * Validate that an effort level is one of "low", "medium", "high".
 */
export function isValidEffort(value: string): value is "low" | "medium" | "high" {
  return VALID_EFFORTS.has(value);
}

/**
 * Apply a model override for a role. Returns a new overrides object (immutable
 * update style). Provider and/or model may be omitted; omitted fields leave
 * the existing override (or underlying route) as-is.
 */
export function applyModelOverride(
  overrides: SessionModelOverrides,
  role: ModelRole,
  target: { provider?: string; model: string },
): SessionModelOverrides {
  const existing = overrides.roles[role];
  return {
    ...overrides,
    roles: {
      ...overrides.roles,
      [role]: {
        ...(existing ?? {}),
        provider: target.provider ?? existing?.provider,
        model: target.model,
      },
    },
  };
}

/**
 * Apply a reasoning-effort override for a role. If `effort` is omitted and only
 * a level is given, sets the default session effort instead.
 *
 * When `role` is provided, sets that role's effort. Otherwise sets
 * `defaultReasoningEffort`.
 */
export function applyEffortOverride(
  overrides: SessionModelOverrides,
  effort: "low" | "medium" | "high",
  role?: ModelRole,
): SessionModelOverrides {
  if (role) {
    const existing = overrides.roles[role];
    return {
      ...overrides,
      roles: {
        ...overrides.roles,
        [role]: {
          ...(existing ?? {}),
          reasoningEffort: effort,
        },
      },
    };
  }
  // Global default
  return {
    ...overrides,
    defaultReasoningEffort: effort,
  };
}

/**
 * Clear a model override for a single role. Resets only that role's entry.
 * If role is "all", clears every role override (but preserves defaultReasoningEffort).
 */
export function clearModelOverride(
  overrides: SessionModelOverrides,
  role: ModelRole | "all",
): SessionModelOverrides {
  if (role === "all") {
    return { ...overrides, roles: {} };
  }
  const copy = { ...overrides.roles };
  delete copy[role];
  return { ...overrides, roles: copy };
}

/**
 * Clear an effort override for a single role or globally.
 * If role is "all", clears both defaultReasoningEffort and all role-level efforts.
 */
export function clearEffortOverride(
  overrides: SessionModelOverrides,
  role?: ModelRole | "all",
): SessionModelOverrides {
  if (role === undefined) {
    // Clear default effort only
    return { ...overrides, defaultReasoningEffort: undefined };
  }
  if (role === "all") {
    // Clear both default and all role efforts
    const roles = {} as Partial<Record<ModelRole, SessionModelOverride>>;
    for (const [r, ov] of Object.entries(overrides.roles)) {
      if (ov) {
        const { reasoningEffort: _, ...rest } = ov;
        if (Object.keys(rest).length > 0) roles[r as ModelRole] = rest;
      }
    }
    return { ...overrides, roles, defaultReasoningEffort: undefined };
  }
  // Clear a specific role's effort only
  const existing = overrides.roles[role];
  if (!existing) return overrides; // nothing to clear
  const { reasoningEffort: _, ...rest } = existing;
  if (Object.keys(rest).length === 0) {
    // No other overrides for this role → remove the entry entirely
    return clearModelOverride(overrides, role);
  }
  return {
    ...overrides,
    roles: {
      ...overrides.roles,
      [role]: rest,
    },
  };
}
