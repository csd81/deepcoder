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
import type { ContextConfig, SkillsConfig, DependencyHealingConfig, DelegateConfig } from "./config.js";

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

const qualityGateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["mandatory", "advisory"]).optional(),
  blockOnReviewerError: z.boolean().optional(),
  minimumBlockingSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
  maxPatchBytes: z.number().int().positive().optional(),
  maxContextBytes: z.number().int().positive().optional(),
});

const delegateSchema = z.object({
  qualityGate: qualityGateSchema.optional(),
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

  return { mcpServers, checks, sandbox, workspaceIsolation, hooks, context, skills, dependencyHealing, delegate };
}

function warn(msg: string): void {
  process.stderr.write(`Warning: .deepcoder/config.json — ${msg}\n`);
}
