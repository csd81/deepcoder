/**
 * Phase 10F — Model Router types.
 *
 * Named model roles map internal task types to provider/model/runtime settings.
 * The router resolves a role to a complete ResolvedModelRoute, then the caller
 * uses that to create or select a provider.
 */

export type ModelRole =
  | "edit"
  | "plan"
  | "review"
  | "research"
  | "summarize"
  | "triage"
  | "explore"
  | "delegate"
  | "qualityGate"
  | "fallback";

/** All known roles — used for validation and iteration. */
export const ALL_ROLES: readonly ModelRole[] = [
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
] as const;

/** Role set that is safe for fallback (read-only, no tools). */
export const READONLY_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>([
  "plan",
  "review",
  "research",
  "summarize",
  "triage",
  "explore",
  "qualityGate",
]);

/**
 * A route as it appears in config (file, env, or CLI). All fields optional
 * except `model` — the router fills in defaults for anything missing.
 */
export interface ModelRoute {
  role: ModelRole;
  provider?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTurns?: number;
  fallbackRoles?: ModelRole[];
  fallbackModels?: string[];
}

/**
 * A fully resolved route — every field has a concrete value. This is what
 * callers use to create a provider and run a model call.
 */
export interface ResolvedModelRoute {
  role: ModelRole;
  provider: string;
  model: string;
  baseUrl: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  source: "default" | "file" | "env" | "cli";
}

/** Shape of the `models` block in .deepcoder/config.json. */
export interface ModelsFileConfig {
  roles?: Partial<Record<ModelRole, Omit<ModelRoute, "role">>>;
  fallbacks?: Partial<Record<ModelRole, ModelRole[]>>;
}
