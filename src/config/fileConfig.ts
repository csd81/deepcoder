import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type McpMode = "readonly" | "execute";

export interface McpServerConfig {
  command: string;
  args?: string[];
  enabled?: boolean;
  /** Operator's trust assertion about the server. Defaults to "execute" (untrusted). */
  mode?: McpMode;
}

export interface CheckConfig {
  command: string;
  timeoutMs?: number;
}

import type { SandboxConfig } from "../sandbox/types.js";
import type { WorkspaceIsolationConfig } from "../workspaceIsolation/types.js";
import type { HooksConfig } from "../hooks/types.js";
import type { ContextConfig, SkillsConfig, DependencyHealingConfig, DelegateConfig, TestTargetingConfig, SemanticSearchConfig } from "./config.js";
import type { DiagnosticsConfig } from "../diagnostics/types.js";
import type { ModelsFileConfig } from "../models/types.js";
import type { ModelPricing } from "../providers/pricing.js";
import { hasFallbackCycle } from "../models/router.js";

export interface TelemetryConfig {
  statusline?: boolean;
  costs?: boolean;
  pricing?: ModelPricing[];
}

/** Shape of `.deepcoder/config.json` (all fields optional). */
export interface FileConfig {
  mcpServers?: Record<string, McpServerConfig>;
  checks?: Record<string, CheckConfig>;
  sandbox?: Partial<SandboxConfig>;
  workspaceIsolation?: Partial<WorkspaceIsolationConfig>;
  hooks?: Partial<HooksConfig>;
  context?: Partial<ContextConfig>;
  skills?: Partial<SkillsConfig>;
  dependencyHealing?: Partial<DependencyHealingConfig>;
  delegate?: Partial<DelegateConfig>;
  testTargeting?: Partial<TestTargetingConfig>;
  diagnostics?: Partial<DiagnosticsConfig>;
  semanticSearch?: Partial<SemanticSearchConfig>;
  models?: ModelsFileConfig;
  telemetry?: TelemetryConfig;
}

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["readonly", "execute"]).optional(),
});

const CHECK_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const checkSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const sandboxSchema = z.object({
  mode: z.enum(["off", "fast", "local", "bubblewrap", "sandbox-exec", "docker", "podman", "runsc"]).optional(),
  network: z.enum(["on", "off"]).optional(),
  workspaceWrite: z.boolean().optional(),
  extraMounts: z.array(z.object({ path: z.string().min(1), mode: z.enum(["ro", "rw"]) })).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  fallback: z.enum(["ask", "local", "fail"]).optional(),
});

const workspaceIsolationSchema = z.object({
  mode: z.enum(["off", "patch", "keep"]).optional(),
  backend: z.enum(["auto", "git-worktree", "copy"]).optional(),
  keepOnSuccess: z.boolean().optional(),
  keepOnFailure: z.boolean().optional(),
  includeDirty: z.boolean().optional(),
  exclude: z.array(z.string()).optional(),
  provision: z.array(z.string()).optional(),
  setupCommands: z.array(z.string()).optional(),
});

const hookConfigSchema = z.object({
  name: z.string().min(1),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

const hooksSchema = z.object({
  enabled: z.boolean().optional(),
  events: z
    .object({
      PreToolUse: z.array(hookConfigSchema).optional(),
    })
    .optional(),
});

const contextSchema = z.object({
  instructionGraph: z.boolean().optional(),
  instructionImports: z.boolean().optional(),
  instructionImportMaxDepth: z.number().int().min(0).max(16).optional(),
  instructionImportMaxBytes: z.number().int().min(0).optional(),
  preflight: z.boolean().optional(),
  preflightMaxBytes: z.number().int().min(0).optional(),
  explorerMaxTurns: z.number().int().min(1).max(50).optional(),
});

const skillsSchema = z.object({
  enabled: z.boolean().optional(),
  trustWorkspaceSkills: z.boolean().optional(),
  catalogMaxChars: z.number().int().min(0).optional(),
  activationMaxBytes: z.number().int().min(0).optional(),
  disabled: z.array(z.string()).optional(),
});

const dependencyHealingSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.enum(["on", "off"]).optional(),
  maxAttempts: z.number().int().positive().optional(),
  allowPackageScripts: z.boolean().optional(),
  managers: z.array(z.string()).optional(),
  preferFrozenLockfile: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const KNOWN_MODEL_ROLES = [
  "edit", "plan", "review", "research", "summarize", "triage",
  "explore", "delegate", "qualityGate", "fallback",
] as const;

const modelRoleSchema = z.enum(KNOWN_MODEL_ROLES);

const modelRouteConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  temperature: z.number().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

const modelsSchema = z.object({
  roles: z.record(modelRoleSchema, modelRouteConfigSchema).optional(),
  fallbacks: z.record(modelRoleSchema, z.array(modelRoleSchema)).optional(),
});

const qualityGateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["mandatory", "advisory"]).optional(),
  blockOnReviewerError: z.boolean().optional(),
  minimumBlockingSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
  maxPatchBytes: z.number().int().positive().optional(),
  maxContextBytes: z.number().int().positive().optional(),
});

const acceptanceFirstSchema = z.object({
  enabled: z.boolean().optional(),
});

const delegateSchema = z.object({
  qualityGate: qualityGateSchema.optional(),
  acceptanceFirst: acceptanceFirstSchema.optional(),
});

const diagnosticRuleSchema = z.object({
  name: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  debounceMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
});

const diagnosticsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["advisory"]).optional(),
  maxPerTurn: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  rules: z.array(diagnosticRuleSchema).optional(),
});

/**
 * Load `.deepcoder/config.json` from the workspace root. Missing files are
 * silently tolerated; a malformed file or invalid entries warn to stderr and
 * are skipped (a bad config never blocks startup). Each MCP server is validated
 * independently so one bad entry doesn't discard the others.
 */
export function loadFileConfig(workspaceRoot: string): FileConfig {
  const file = path.join(workspaceRoot, ".deepcoder", "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`malformed JSON (${(err as Error).message})`);
    return {};
  }
  if (!parsed || typeof parsed !== "object") {
    warn("top-level value is not an object");
    return {};
  }

  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  const mcpServers: Record<string, McpServerConfig> = {};
  if (servers && typeof servers === "object") {
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      const result = mcpServerSchema.safeParse(value);
      if (result.success) mcpServers[name] = result.data;
      else warn(`ignoring mcpServers["${name}"]: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  const rawChecks = (parsed as { checks?: unknown }).checks;
  const checks: Record<string, CheckConfig> = {};
  if (rawChecks && typeof rawChecks === "object") {
    for (const [name, value] of Object.entries(rawChecks as Record<string, unknown>)) {
      if (!CHECK_NAME_RE.test(name)) {
        warn(`ignoring check "${name}": name must match ${CHECK_NAME_RE}`);
        continue;
      }
      const result = checkSchema.safeParse(value);
      if (result.success) checks[name] = result.data;
      else warn(`ignoring checks["${name}"]: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  const rawSandbox = (parsed as { sandbox?: unknown }).sandbox;
  let sandbox: Partial<SandboxConfig> | undefined;
  if (rawSandbox && typeof rawSandbox === "object") {
    const result = sandboxSchema.safeParse(rawSandbox);
    if (result.success) sandbox = result.data;
    else warn(`ignoring "sandbox": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawIso = (parsed as { workspaceIsolation?: unknown }).workspaceIsolation;
  let workspaceIsolation: Partial<WorkspaceIsolationConfig> | undefined;
  if (rawIso && typeof rawIso === "object") {
    const result = workspaceIsolationSchema.safeParse(rawIso);
    if (result.success) workspaceIsolation = result.data;
    else warn(`ignoring "workspaceIsolation": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawHooks = (parsed as { hooks?: unknown }).hooks;
  let hooks: Partial<HooksConfig> | undefined;
  if (rawHooks && typeof rawHooks === "object") {
    const result = hooksSchema.safeParse(rawHooks);
    if (result.success) hooks = result.data as Partial<HooksConfig>;
    else warn(`ignoring "hooks": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawContext = (parsed as { context?: unknown }).context;
  let context: Partial<ContextConfig> | undefined;
  if (rawContext && typeof rawContext === "object") {
    const result = contextSchema.safeParse(rawContext);
    if (result.success) context = result.data;
    else warn(`ignoring "context": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawSkills = (parsed as { skills?: unknown }).skills;
  let skills: Partial<SkillsConfig> | undefined;
  if (rawSkills && typeof rawSkills === "object") {
    const result = skillsSchema.safeParse(rawSkills);
    if (result.success) skills = result.data;
    else warn(`ignoring "skills": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawDepHealing = (parsed as { dependencyHealing?: unknown }).dependencyHealing;
  let dependencyHealing: Partial<DependencyHealingConfig> | undefined;
  if (rawDepHealing && typeof rawDepHealing === "object") {
    const result = dependencyHealingSchema.safeParse(rawDepHealing);
    if (result.success) dependencyHealing = result.data as Partial<DependencyHealingConfig>;
    else warn(`ignoring "dependencyHealing": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawDelegate = (parsed as { delegate?: unknown }).delegate;
  let delegate: Partial<DelegateConfig> | undefined;
  if (rawDelegate && typeof rawDelegate === "object") {
    const result = delegateSchema.safeParse(rawDelegate);
    if (result.success) delegate = result.data as Partial<DelegateConfig>;
    else warn(`ignoring "delegate": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawModels = (parsed as { models?: unknown }).models;
  let models: ModelsFileConfig | undefined;
  if (rawModels && typeof rawModels === "object") {
    const result = modelsSchema.safeParse(rawModels);
    if (result.success) {
      models = result.data as ModelsFileConfig;
      // Reject a cyclic fallback graph (would loop forever at resolution).
      if (hasFallbackCycle(models.fallbacks)) {
        warn(`ignoring "models.fallbacks": fallback cycle detected`);
        models = { ...models, fallbacks: undefined };
      }
    } else {
      warn(`ignoring "models": ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  const rawDiagnostics = (parsed as { diagnostics?: unknown }).diagnostics;
  let diagnostics: Partial<DiagnosticsConfig> | undefined;
  if (rawDiagnostics && typeof rawDiagnostics === "object") {
    const result = diagnosticsSchema.safeParse(rawDiagnostics);
    if (result.success) diagnostics = result.data as Partial<DiagnosticsConfig>;
    else warn(`ignoring "diagnostics": ${result.error.issues.map((i) => i.message).join("; ")}`);
  }

  const rawTestTargeting = (parsed as { testTargeting?: unknown }).testTargeting;
  let testTargeting: Partial<TestTargetingConfig> | undefined;
  if (rawTestTargeting && typeof rawTestTargeting === "object") {
    const raw = rawTestTargeting as Record<string, unknown>;
    testTargeting = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
      mode: typeof raw.mode === "string" && ["off", "suggest", "targeted-first", "targeted-only"].includes(raw.mode)
        ? (raw.mode as TestTargetingConfig["mode"])
        : undefined,
      fallbackCheck: typeof raw.fallbackCheck === "string" ? raw.fallbackCheck : undefined,
      maxTargets: typeof raw.maxTargets === "number" && raw.maxTargets > 0 ? raw.maxTargets : undefined,
      minConfidence: typeof raw.minConfidence === "string" && ["high", "medium", "low", "none"].includes(raw.minConfidence)
        ? (raw.minConfidence as TestTargetingConfig["minConfidence"])
        : undefined,
      runFullAfterTargetedPass: typeof raw.runFullAfterTargetedPass === "boolean" ? raw.runFullAfterTargetedPass : undefined,
      languageCommands: raw.languageCommands && typeof raw.languageCommands === "object"
        ? (raw.languageCommands as Record<string, string>)
        : undefined,
      pathRules: Array.isArray(raw.pathRules)
        ? raw.pathRules.filter(
            (r: unknown): r is { changed: string; tests: string[] } =>
              typeof r === "object" && r !== null && typeof (r as Record<string, unknown>).changed === "string" && Array.isArray((r as Record<string, unknown>).tests),
          )
        : undefined,
    };
  }

  const rawSemanticSearch = (parsed as { semanticSearch?: unknown }).semanticSearch;
  let semanticSearch: Partial<SemanticSearchConfig> | undefined;
  if (rawSemanticSearch && typeof rawSemanticSearch === "object") {
    const raw = rawSemanticSearch as Record<string, unknown>;
    semanticSearch = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
      dimensions: typeof raw.dimensions === "number" ? raw.dimensions : undefined,
      hybridLexicalWeight: typeof raw.hybridLexicalWeight === "number" ? raw.hybridLexicalWeight : undefined,
      topK: typeof raw.topK === "number" ? raw.topK : undefined,
    };
  }

  const rawTelemetry = (parsed as { telemetry?: unknown }).telemetry;
  let telemetry: TelemetryConfig | undefined;
  if (rawTelemetry && typeof rawTelemetry === "object") {
    const raw = rawTelemetry as Record<string, unknown>;
    telemetry = {
      statusline: typeof raw.statusline === "boolean" ? raw.statusline : undefined,
      costs: typeof raw.costs === "boolean" ? raw.costs : undefined,
      pricing: Array.isArray(raw.pricing)
        ? raw.pricing.filter(
            (p: unknown): p is ModelPricing =>
              typeof p === "object" && p !== null &&
              typeof (p as Record<string, unknown>).provider === "string" &&
              typeof (p as Record<string, unknown>).modelPattern === "string" &&
              typeof (p as Record<string, unknown>).inputPerMillionUsd === "number" &&
              typeof (p as Record<string, unknown>).outputPerMillionUsd === "number" &&
              typeof (p as Record<string, unknown>).effectiveDate === "string",
          )
        : undefined,
    };
  }

  return { mcpServers, checks, sandbox, workspaceIsolation, hooks, context, skills, dependencyHealing, delegate, models, testTargeting, diagnostics, telemetry, semanticSearch };
}

function warn(msg: string): void {
  process.stderr.write(`Warning: .deepcoder/config.json — ${msg}\n`);
}
