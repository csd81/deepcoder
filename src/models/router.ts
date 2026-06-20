/**
 * Phase 10F — Model Router.
 *
 * Central policy layer that maps internal task roles to provider/model settings.
 * With no new config/env, every role resolves to the current model selection
 * (byte-identical behavior). Routing NEVER changes tool permissions.
 */

import type { Config } from "../config/config.js";
import type {
  ModelRole,
  ModelRoute,
  ResolvedModelRoute,
  ModelsFileConfig,
} from "./types.js";

/**
 * Detect a cycle in a fallback graph (role → fallback roles). A cyclic fallback
 * chain could loop forever at resolution time, so config load rejects it. Pure.
 */
export function hasFallbackCycle(
  fallbacks: Partial<Record<ModelRole, ModelRole[]>> | undefined,
): boolean {
  if (!fallbacks) return false;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of fallbacks[node as ModelRole] ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true; // back-edge → cycle
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };
  for (const role of Object.keys(fallbacks)) {
    if ((color.get(role) ?? WHITE) === WHITE && visit(role)) return true;
  }
  return false;
}

export class ModelRouter {
  private config: Config;
  private fileRoles: Partial<Record<ModelRole, Omit<ModelRoute, "role">>>;
  private fileFallbacks: Partial<Record<ModelRole, ModelRole[]>>;

  constructor(config: Config, fileModels?: ModelsFileConfig) {
    this.config = config;
    this.fileRoles = fileModels?.roles ?? {};
    this.fileFallbacks = fileModels?.fallbacks ?? {};
  }

  /**
   * Resolve a role to a complete ResolvedModelRoute.
   *
   * Precedence (highest first):
   *   1. CLI override (not yet implemented — future)
   *   2. Environment variable (DEEPCODER_MODEL_<ROLE>, DEEPCODER_PROVIDER_<ROLE>, etc.)
   *   3. File config (.deepcoder/config.json → models.roles.<role>)
   *   4. Default (back-compat mapping from config.model / config.reasonerModel / config.subagentModel)
   */
  resolve(role: ModelRole): ResolvedModelRoute {
    // Try env override first
    const envRoute = this.resolveFromEnv(role);
    if (envRoute) return envRoute;

    // Try file config
    const fileRoute = this.resolveFromFile(role);
    if (fileRoute) return fileRoute;

    // Fall back to default
    return this.resolveDefault(role);
  }

  /**
   * Return the effective routing table for all roles (for /models explain).
   */
  explain(): ResolvedModelRoute[] {
    const roles: ModelRole[] = [
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
    ];
    return roles.map((r) => this.resolve(r));
  }

  /**
   * Return the fallback chain for a role (empty array = no fallback).
   */
  fallbackChain(role: ModelRole): ModelRole[] {
    // Env fallback
    const envRaw = process.env[`DEEPCODER_FALLBACK_${role.toUpperCase()}`];
    if (envRaw) {
      return envRaw.split(",").map((s) => s.trim() as ModelRole).filter((r) => r);
    }
    // File fallback
    const fileChain = this.fileFallbacks[role];
    if (fileChain && fileChain.length > 0) return fileChain;
    return [];
  }

  // ---- private helpers ----

  private resolveFromEnv(role: ModelRole): ResolvedModelRoute | null {
    const roleUpper = role.toUpperCase();
    const model = process.env[`DEEPCODER_MODEL_${roleUpper}`];
    if (!model) return null;

    const provider = process.env[`DEEPCODER_PROVIDER_${roleUpper}`] ?? this.config.provider;
    const baseUrl = process.env[`DEEPCODER_BASE_URL_${roleUpper}`] ?? this.config.baseUrl;
    const tempRaw = process.env[`DEEPCODER_TEMPERATURE_${roleUpper}`];
    let temperature: number | undefined;
    if (tempRaw !== undefined && tempRaw !== "") {
      const n = Number(tempRaw);
      temperature = Number.isFinite(n) ? n : undefined;
    }

    return {
      role,
      provider,
      model,
      baseUrl: baseUrl ?? "",
      temperature,
      source: "env",
    };
  }

  private resolveFromFile(role: ModelRole): ResolvedModelRoute | null {
    const fileRole = this.fileRoles[role];
    if (!fileRole || !fileRole.model) return null;

    const provider = fileRole.provider ?? this.config.provider;
    const baseUrl = fileRole.baseUrl ?? this.config.baseUrl;

    return {
      role,
      provider,
      model: fileRole.model,
      baseUrl: baseUrl ?? "",
      temperature: fileRole.temperature,
      reasoningEffort: fileRole.reasoningEffort,
      source: "file",
    };
  }

  private resolveDefault(role: ModelRole): ResolvedModelRoute {
    switch (role) {
      case "edit":
        return {
          role,
          provider: this.config.provider,
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          temperature: this.config.temperature,
          reasoningEffort: this.config.reasoningEffort,
          source: "default",
        };
      case "plan":
        return {
          role,
          provider: this.config.provider,
          model: this.config.reasonerModel ?? this.config.model,
          baseUrl: this.config.baseUrl,
          temperature: this.config.temperature,
          reasoningEffort: this.config.reasoningEffort,
          source: "default",
        };
      case "review":
      case "research":
      case "triage":
      case "explore":
        return {
          role,
          provider: this.config.provider,
          model: this.config.subagentModel ?? this.config.model,
          baseUrl: this.config.baseUrl,
          temperature: this.config.temperature,
          reasoningEffort: this.config.reasoningEffort,
          source: "default",
        };
      case "delegate":
        return {
          role,
          provider: this.config.provider,
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          temperature: this.config.temperature,
          reasoningEffort: this.config.reasoningEffort,
          source: "default",
        };
      case "qualityGate":
        // qualityGate defaults to review (which defaults to subagentModel or edit)
        return this.resolveDefault("review");
      case "summarize":
      case "fallback":
        return {
          role,
          provider: this.config.provider,
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          temperature: this.config.temperature,
          reasoningEffort: this.config.reasoningEffort,
          source: "default",
        };
    }
  }
}
