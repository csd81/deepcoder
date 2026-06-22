/**
 * Phase 10Q — /debug-config provenance collector.
 *
 * Pure module: computes a bounded, secret-redacted view of the effective
 * configuration and reconstructs candidate precedence for each supported key.
 * No terminal I/O, no network, no model calls.
 */
import { loadFileConfig as defaultLoadFileConfig } from "./fileConfig.js";
import { isWorkspaceTrusted as defaultIsWorkspaceTrusted } from "./trust.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Public types (match the plan exactly)
// ---------------------------------------------------------------------------

export type ConfigSource =
  | "default"
  | "file"
  | "env"
  | "cli"
  | "session"
  | "trust-gate"
  | "normalized";

export interface ConfigCandidate {
  source: ConfigSource;
  sourceRef: string;
  present: boolean;
  wins: boolean;
  value?: string | number | boolean | null;
  redacted?: boolean;
}

export interface DebugConfigEntry {
  key: string;
  value: string | number | boolean | null;
  redacted: boolean;
  source: ConfigSource;
  sourceRef: string;
  candidates: ConfigCandidate[];
  notes?: string[];
}

export interface DebugConfigReport {
  entries: DebugConfigEntry[];
  warnings: string[];
}

export interface BuildDebugConfigInput {
  config: Config;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  cliOverrides?: Record<string, unknown>;
  sessionOverrides?: Record<string, unknown>;
  loadFileConfig?: typeof defaultLoadFileConfig;
  isWorkspaceTrusted?: (root: string) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keys whose value must never be printed in the clear. */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /apikey/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth/i,
  /cookie/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/** Redact a value: only show `<set>` or `<unset>`. */
function redactValue(value: unknown): string | boolean | number | null {
  // Idempotent: already-redacted sentinels must pass through unchanged so a
  // double-redaction (e.g. the `add` helper re-running an already-redacted
  // value) never flips an unset key to "<set>".
  if (value === "<unset>") return "<unset>";
  if (value === "<set>") return "<set>";
  if (value === undefined || value === null || value === "") return "<unset>";
  return "<set>";
}

/** Per-provider env-var prefix (mirrors config.ts). */
const PROVIDER_ENV_PREFIX: Record<string, string> = {
  deepseek: "DEEPSEEK",
  "openai-compatible": "OPENAI",
};

/** Default model per provider (mirrors config.ts). */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  "openai-compatible": "deepseek-v4-flash",
};

interface BuildContext {
  config: Config;
  env: NodeJS.ProcessEnv;
  file: import("./fileConfig.js").FileConfig;
  cliOverrides?: Record<string, unknown>;
  sessionOverrides?: Record<string, unknown>;
  provider: string;
  prefix: string;
  trusted: boolean;
  fileHadMcp: boolean;
  fileHadHooks: boolean;
}

// ---------------------------------------------------------------------------
// Key definitions
// ---------------------------------------------------------------------------

function defineKeys(ctx: BuildContext): DebugConfigEntry[] {
  const { config, env, file, cliOverrides, sessionOverrides, provider, prefix, trusted } = ctx;

  const entries: DebugConfigEntry[] = [];

  function add(
    key: string,
    value: string | number | boolean | null,
    source: ConfigSource,
    sourceRef: string,
    candidates: ConfigCandidate[],
    notes?: string[],
  ) {
    const redacted = isSecretKey(key);
    entries.push({
      key,
      value: redacted ? redactValue(value) : value,
      redacted,
      source,
      sourceRef,
      candidates: candidates.map((c) => ({
        ...c,
        value: c.redacted || (redacted && c.source !== "default") ? redactValue(c.value) : c.value,
        ...(c.redacted || (redacted && c.source !== "default") ? { redacted: true } : {}),
      })),
      notes,
    });
  }

  // --- provider ---
  {
    const defaultValue = "deepseek";
    const envVar = "DEEPCODER_PROVIDER";
    const envVal = env[envVar] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "provider",
      config.provider,
      envPresent ? "env" : "default",
      envPresent ? envVar : "hardcoded default",
      [
        { source: "env", sourceRef: envVar, present: envPresent, wins: envPresent, value: envPresent ? config.provider : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent, value: defaultValue },
      ],
    );
  }

  // --- model ---
  {
    const defaultModel = PROVIDER_DEFAULT_MODELS[provider] ?? "deepseek-chat";
    const providerEnvVar = `${prefix}_MODEL`;
    const envVal = env["DEEPCODER_MODEL"] as string | undefined;
    const providerEnvVal = env[providerEnvVar] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const providerEnvPresent = providerEnvVal !== undefined && providerEnvVal !== "";
    // DEEPCODER_MODEL wins over provider-specific env
    const winningEnv = envPresent ? "DEEPCODER_MODEL" : providerEnvPresent ? providerEnvVar : undefined;
    const winningSource = winningEnv ? "env" : "default";
    add(
      "model",
      config.model,
      winningSource,
      winningEnv ?? "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_MODEL", present: envPresent, wins: envPresent, value: envPresent ? config.model : undefined },
        { source: "env", sourceRef: providerEnvVar, present: providerEnvPresent, wins: !envPresent && providerEnvPresent, value: providerEnvPresent ? config.model : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent && !providerEnvPresent, value: defaultModel },
      ],
    );
  }

  // --- apiKey (always redacted) ---
  {
    const envVal = env["DEEPCODER_API_KEY"] as string | undefined;
    const providerEnvVal = env[`${prefix}_API_KEY`] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const providerEnvPresent = providerEnvVal !== undefined && providerEnvVal !== "";
    add(
      "apiKey",
      config.apiKey ? "<set>" : "<unset>",
      "env",
      envPresent ? "DEEPCODER_API_KEY" : providerEnvPresent ? `${prefix}_API_KEY` : "unset",
      [
        { source: "env", sourceRef: "DEEPCODER_API_KEY", present: envPresent, wins: envPresent, value: envPresent ? "<set>" : undefined, redacted: true },
        { source: "env", sourceRef: `${prefix}_API_KEY`, present: providerEnvPresent, wins: !envPresent && providerEnvPresent, value: providerEnvPresent ? "<set>" : undefined, redacted: true },
        { source: "default", sourceRef: "unset", present: false, wins: false, value: "<unset>" },
      ],
      undefined,
    );
  }

  // --- baseUrl ---
  {
    const envVal = env["DEEPCODER_BASE_URL"] as string | undefined;
    const providerEnvVal = env[`${prefix}_BASE_URL`] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const providerEnvPresent = providerEnvVal !== undefined && providerEnvVal !== "";
    add(
      "baseUrl",
      config.baseUrl || "",
      envPresent ? "env" : providerEnvPresent ? "env" : "default",
      envPresent ? "DEEPCODER_BASE_URL" : providerEnvPresent ? `${prefix}_BASE_URL` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_BASE_URL", present: envPresent, wins: envPresent, value: envPresent ? config.baseUrl : undefined },
        { source: "env", sourceRef: `${prefix}_BASE_URL`, present: providerEnvPresent, wins: !envPresent && providerEnvPresent, value: providerEnvPresent ? config.baseUrl : undefined },
        { source: "default", sourceRef: "hardcoded default (empty)", present: true, wins: !envPresent && !providerEnvPresent, value: "" },
      ],
    );
  }

  // --- temperature ---
  {
    const { candidates, winnerSource, winnerRef } = envVsDefaultWithProvider(
      "DEEPCODER_TEMPERATURE",
      0,
      config.temperature ?? null,
      env,
    );
    add("temperature", config.temperature ?? null, winnerSource, winnerRef, candidates);
  }

  // --- reasoningEffort ---
  {
    const { candidates, winnerSource, winnerRef } = envVsDefaultWithProvider(
      "DEEPCODER_REASONING_EFFORT",
      "medium",
      config.reasoningEffort ?? "medium",
      env,
    );
    add("reasoningEffort", config.reasoningEffort ?? "medium", winnerSource, winnerRef, candidates);
  }

  // --- reasonerModel ---
  {
    const envVal = env["DEEPCODER_REASONER_MODEL"] as string | undefined;
    const providerEnvVal = env[`${prefix}_REASONER_MODEL`] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const providerEnvPresent = providerEnvVal !== undefined && providerEnvVal !== "";
    const present = envPresent || providerEnvPresent;
    add(
      "reasonerModel",
      config.reasonerModel ?? null,
      present ? "env" : "default",
      envPresent ? "DEEPCODER_REASONER_MODEL" : providerEnvPresent ? `${prefix}_REASONER_MODEL` : "unset",
      [
        { source: "env", sourceRef: "DEEPCODER_REASONER_MODEL", present: envPresent, wins: envPresent, value: envPresent ? config.reasonerModel ?? null : undefined },
        { source: "env", sourceRef: `${prefix}_REASONER_MODEL`, present: providerEnvPresent, wins: !envPresent && providerEnvPresent, value: providerEnvPresent ? config.reasonerModel ?? null : undefined },
        { source: "default", sourceRef: "unset (falls back to model)", present: true, wins: !present, value: null },
      ],
    );
  }

  // --- subagentModel ---
  {
    const envVal = env["DEEPCODER_SUBAGENT_MODEL"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "subagentModel",
      config.subagentModel ?? null,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_SUBAGENT_MODEL" : "unset (defaults to model)",
      [
        { source: "env", sourceRef: "DEEPCODER_SUBAGENT_MODEL", present: envPresent, wins: envPresent, value: envPresent ? config.subagentModel ?? null : undefined },
        { source: "default", sourceRef: "unset (defaults to model)", present: true, wins: !envPresent, value: null },
      ],
    );
  }

  // --- approvalMode ---
  {
    const envVal = env["DEEPCODER_APPROVAL_MODE"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const defaultValue = "ask";
    add(
      "approvalMode",
      config.approvalMode,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_APPROVAL_MODE" : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_APPROVAL_MODE", present: envPresent, wins: envPresent, value: envPresent ? config.approvalMode : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent, value: defaultValue },
      ],
    );
  }

  // --- maxTurns ---
  {
    const envVal = env["DEEPCODER_MAX_TURNS"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "maxTurns",
      config.maxTurns,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_MAX_TURNS" : "hardcoded default (40)",
      [
        { source: "env", sourceRef: "DEEPCODER_MAX_TURNS", present: envPresent, wins: envPresent, value: envPresent ? config.maxTurns : undefined },
        { source: "default", sourceRef: "hardcoded default (40)", present: true, wins: !envPresent, value: 40 },
      ],
    );
  }

  // --- contextBudgetTokens ---
  {
    const envVal = env["DEEPCODER_CONTEXT_BUDGET_TOKENS"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "contextBudgetTokens",
      config.contextBudgetTokens,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_CONTEXT_BUDGET_TOKENS" : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_CONTEXT_BUDGET_TOKENS", present: envPresent, wins: envPresent, value: envPresent ? config.contextBudgetTokens : undefined },
        { source: "default", sourceRef: "hardcoded default (120000)", present: true, wins: !envPresent, value: 120000 },
      ],
    );
  }

  // --- compactAt ---
  {
    const envVal = env["DEEPCODER_COMPACT_AT"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "compactAt",
      config.compactAt,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_COMPACT_AT" : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_COMPACT_AT", present: envPresent, wins: envPresent, value: envPresent ? config.compactAt : undefined },
        { source: "default", sourceRef: "hardcoded default (0.8)", present: true, wins: !envPresent, value: 0.8 },
      ],
    );
  }

  // --- checkpoints ---
  {
    const envVal = env["DEEPCODER_CHECKPOINTS"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "checkpoints",
      config.checkpoints,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_CHECKPOINTS" : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_CHECKPOINTS", present: envPresent, wins: envPresent, value: envPresent ? config.checkpoints : undefined },
        { source: "default", sourceRef: "hardcoded default (off)", present: true, wins: !envPresent, value: "off" },
      ],
    );
  }

  // --- sandbox.mode ---
  {
    const defaultValue = "fast";
    const fileVal = file.sandbox?.mode as string | undefined;
    const envVal = env["DEEPCODER_SANDBOX"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = fileVal !== undefined;
    const cliVal = cliOverrides?.sandbox && typeof cliOverrides.sandbox === "object"
      ? (cliOverrides.sandbox as Record<string, unknown>).mode as string | undefined
      : undefined;
    const cliPresent = cliVal !== undefined;
    const sessionVal = sessionOverrides?.sandbox && typeof sessionOverrides.sandbox === "object"
      ? (sessionOverrides.sandbox as Record<string, unknown>).mode as string | undefined
      : undefined;
    const sessionPresent = sessionVal !== undefined;
    const winner = sessionPresent ? "session" : cliPresent ? "cli" : envPresent ? "env" : filePresent ? "file" : "default";
    const winnerRef = sessionPresent ? `/sandbox session override` : cliPresent ? `CLI --sandbox` : envPresent ? "DEEPCODER_SANDBOX" : filePresent ? `.deepcoder/config.json → sandbox.mode` : "hardcoded default";
    add(
      "sandbox.mode",
      config.sandbox.mode,
      winner,
      winnerRef,
      [
        { source: "session", sourceRef: "/sandbox session override", present: sessionPresent, wins: sessionPresent, value: sessionPresent ? config.sandbox.mode : undefined },
        { source: "cli", sourceRef: "CLI --sandbox", present: cliPresent, wins: !sessionPresent && cliPresent, value: cliPresent ? config.sandbox.mode : undefined },
        { source: "env", sourceRef: "DEEPCODER_SANDBOX", present: envPresent, wins: !sessionPresent && !cliPresent && envPresent, value: envPresent ? config.sandbox.mode : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → sandbox.mode`, present: filePresent, wins: !sessionPresent && !cliPresent && !envPresent && filePresent, value: filePresent ? fileVal : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !sessionPresent && !cliPresent && !envPresent && !filePresent, value: defaultValue },
      ],
    );
  }

  // --- sandbox.network ---
  {
    const defaultValue = "on";
    const fileVal = file.sandbox?.network;
    const envVal = env["DEEPCODER_SANDBOX_NETWORK"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = fileVal !== undefined;
    add(
      "sandbox.network",
      config.sandbox.network,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_SANDBOX_NETWORK" : filePresent ? `.deepcoder/config.json → sandbox.network` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_SANDBOX_NETWORK", present: envPresent, wins: envPresent, value: envPresent ? config.sandbox.network : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → sandbox.network`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.sandbox.network : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent && !filePresent, value: defaultValue },
      ],
    );
  }

  // --- sandbox.fallback ---
  {
    const defaultValue = "ask";
    const fileVal = file.sandbox?.fallback;
    const filePresent = fileVal !== undefined;
    add(
      "sandbox.fallback",
      config.sandbox.fallback,
      filePresent ? "file" : "default",
      filePresent ? `.deepcoder/config.json → sandbox.fallback` : "hardcoded default",
      [
        { source: "file", sourceRef: `.deepcoder/config.json → sandbox.fallback`, present: filePresent, wins: filePresent, value: filePresent ? config.sandbox.fallback : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !filePresent, value: defaultValue },
      ],
    );
  }

  // --- workspaceIsolation.mode ---
  {
    const defaultValue = "off";
    const fileVal = file.workspaceIsolation?.mode;
    const envVal = env["DEEPCODER_WORKSPACE_ISOLATION"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = fileVal !== undefined;
    add(
      "workspaceIsolation.mode",
      config.workspaceIsolation.mode,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_WORKSPACE_ISOLATION" : filePresent ? `.deepcoder/config.json → workspaceIsolation.mode` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_WORKSPACE_ISOLATION", present: envPresent, wins: envPresent, value: envPresent ? config.workspaceIsolation.mode : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → workspaceIsolation.mode`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.workspaceIsolation.mode : undefined },
        { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent && !filePresent, value: defaultValue },
      ],
    );
  }

  // --- mcpServers (count) ---
  {
    const mcpCount = Object.keys(config.mcpServers).length;
    const fileMcpCount = Object.keys(file.mcpServers ?? {}).length;
    let notes: string[] | undefined;
    if (fileMcpCount > 0 && !trusted) {
      notes = ["workspace is not trusted; .deepcoder/config.json MCP servers were neutralized by trust-gate"];
    }
    add(
      "mcpServers",
      mcpCount,
      (fileMcpCount > 0 && !trusted) ? "trust-gate" : fileMcpCount > 0 ? "file" : "default",
      (fileMcpCount > 0 && !trusted) ? "trust-gate disabled workspace MCP" : fileMcpCount > 0 ? `.deepcoder/config.json` : "no MCP servers configured",
      [
        { source: "file", sourceRef: ".deepcoder/config.json → mcpServers", present: fileMcpCount > 0, wins: fileMcpCount > 0 && trusted, value: fileMcpCount },
        { source: "trust-gate", sourceRef: "trust-gate", present: fileMcpCount > 0 && !trusted, wins: fileMcpCount > 0 && !trusted, value: 0, redacted: false },
        { source: "default", sourceRef: "no MCP servers configured", present: fileMcpCount === 0, wins: fileMcpCount === 0, value: 0 },
      ],
      notes,
    );
  }

  // --- mcpExecuteEnabled ---
  {
    const envVal = env["DEEPCODER_MCP_EXECUTE"] as string | undefined;
    const envPresent = envVal === "1" || envVal === "true";
    add(
      "mcpExecuteEnabled",
      config.mcpExecuteEnabled,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_MCP_EXECUTE" : "hardcoded default (false)",
      [
        { source: "env", sourceRef: "DEEPCODER_MCP_EXECUTE", present: envPresent, wins: envPresent, value: envPresent ? true : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent, value: false },
      ],
    );
  }

  // --- hooks.enabled ---
  {
    const fileHadHooks = file.hooks?.enabled === true;
    let notes: string[] | undefined;
    if (fileHadHooks && !trusted) {
      notes = ["workspace is not trusted; .deepcoder/config.json hooks were neutralized by trust-gate"];
    }
    add(
      "hooks.enabled",
      config.hooks.enabled,
      (fileHadHooks && !trusted) ? "trust-gate" : file.hooks?.enabled !== undefined ? "file" : "default",
      (fileHadHooks && !trusted) ? "trust-gate disabled workspace hooks" : file.hooks?.enabled !== undefined ? `.deepcoder/config.json → hooks.enabled` : "hardcoded default",
      [
        { source: "file", sourceRef: ".deepcoder/config.json → hooks.enabled", present: file.hooks?.enabled !== undefined, wins: file.hooks?.enabled === true && trusted, value: file.hooks?.enabled ?? undefined },
        { source: "trust-gate", sourceRef: "trust-gate", present: fileHadHooks && !trusted, wins: fileHadHooks && !trusted, value: false },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: file.hooks?.enabled === undefined || (fileHadHooks && !trusted), value: false },
      ],
      notes,
    );
  }

  // --- diagnostics.enabled ---
  {
    const envVal = env["DEEPCODER_DIAGNOSTICS"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.diagnostics?.enabled !== undefined;
    add(
      "diagnostics.enabled",
      config.diagnostics.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DIAGNOSTICS" : filePresent ? `.deepcoder/config.json → diagnostics.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DIAGNOSTICS", present: envPresent, wins: envPresent, value: envPresent ? config.diagnostics.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → diagnostics.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.diagnostics.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- context.instructionGraph ---
  {
    const envVal = env["DEEPCODER_INSTRUCTION_GRAPH"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.context?.instructionGraph !== undefined;
    add(
      "context.instructionGraph",
      config.context.instructionGraph,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_INSTRUCTION_GRAPH" : filePresent ? `.deepcoder/config.json → context.instructionGraph` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_INSTRUCTION_GRAPH", present: envPresent, wins: envPresent, value: envPresent ? config.context.instructionGraph : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → context.instructionGraph`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.context.instructionGraph : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- context.preflight ---
  {
    const envVal = env["DEEPCODER_CONTEXT_PREFLIGHT"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.context?.preflight !== undefined;
    add(
      "context.preflight",
      config.context.preflight,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_CONTEXT_PREFLIGHT" : filePresent ? `.deepcoder/config.json → context.preflight` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_CONTEXT_PREFLIGHT", present: envPresent, wins: envPresent, value: envPresent ? config.context.preflight : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → context.preflight`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.context.preflight : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- skills.enabled ---
  {
    const envVal = env["DEEPCODER_SKILLS"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.skills?.enabled !== undefined;
    add(
      "skills.enabled",
      config.skills.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_SKILLS" : filePresent ? `.deepcoder/config.json → skills.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_SKILLS", present: envPresent, wins: envPresent, value: envPresent ? config.skills.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → skills.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.skills.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (true)", present: true, wins: !envPresent && !filePresent, value: true },
      ],
    );
  }

  // --- skills.trustWorkspaceSkills ---
  {
    const envVal = env["DEEPCODER_SKILLS_TRUST_WORKSPACE"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.skills?.trustWorkspaceSkills !== undefined;
    add(
      "skills.trustWorkspaceSkills",
      config.skills.trustWorkspaceSkills,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_SKILLS_TRUST_WORKSPACE" : filePresent ? `.deepcoder/config.json → skills.trustWorkspaceSkills` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_SKILLS_TRUST_WORKSPACE", present: envPresent, wins: envPresent, value: envPresent ? config.skills.trustWorkspaceSkills : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → skills.trustWorkspaceSkills`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.skills.trustWorkspaceSkills : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- dependencyHealing.enabled ---
  {
    const envVal = env["DEEPCODER_DEP_HEALING"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.dependencyHealing?.enabled !== undefined;
    add(
      "dependencyHealing.enabled",
      config.dependencyHealing.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DEP_HEALING" : filePresent ? `.deepcoder/config.json → dependencyHealing.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DEP_HEALING", present: envPresent, wins: envPresent, value: envPresent ? config.dependencyHealing.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → dependencyHealing.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.dependencyHealing.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- dependencyHealing.network ---
  {
    const envVal = env["DEEPCODER_DEP_HEALING_NETWORK"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.dependencyHealing?.network !== undefined;
    add(
      "dependencyHealing.network",
      config.dependencyHealing.network,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DEP_HEALING_NETWORK" : filePresent ? `.deepcoder/config.json → dependencyHealing.network` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DEP_HEALING_NETWORK", present: envPresent, wins: envPresent, value: envPresent ? config.dependencyHealing.network : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → dependencyHealing.network`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.dependencyHealing.network : undefined },
        { source: "default", sourceRef: "hardcoded default (off)", present: true, wins: !envPresent && !filePresent, value: "off" },
      ],
    );
  }

  // --- delegate.qualityGate.enabled ---
  {
    const envVal = env["DEEPCODER_DELEGATE_QUALITY_GATE"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.delegate?.qualityGate?.enabled !== undefined;
    add(
      "delegate.qualityGate.enabled",
      config.delegate.qualityGate.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DELEGATE_QUALITY_GATE" : filePresent ? `.deepcoder/config.json → delegate.qualityGate.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DELEGATE_QUALITY_GATE", present: envPresent, wins: envPresent, value: envPresent ? config.delegate.qualityGate.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → delegate.qualityGate.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.delegate.qualityGate.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- delegate.acceptanceFirst.enabled ---
  {
    const envVal = env["DEEPCODER_DELEGATE_ACCEPTANCE_FIRST"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.delegate?.acceptanceFirst?.enabled !== undefined;
    add(
      "delegate.acceptanceFirst.enabled",
      config.delegate.acceptanceFirst.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DELEGATE_ACCEPTANCE_FIRST" : filePresent ? `.deepcoder/config.json → delegate.acceptanceFirst.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DELEGATE_ACCEPTANCE_FIRST", present: envPresent, wins: envPresent, value: envPresent ? config.delegate.acceptanceFirst.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → delegate.acceptanceFirst.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.delegate.acceptanceFirst.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- delegate.autopilot.enabled ---
  {
    const envVal = env["DEEPCODER_DELEGATE_AUTOPILOT"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.delegate?.autopilot?.enabled !== undefined;
    add(
      "delegate.autopilot.enabled",
      config.delegate.autopilot.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_DELEGATE_AUTOPILOT" : filePresent ? `.deepcoder/config.json → delegate.autopilot.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_DELEGATE_AUTOPILOT", present: envPresent, wins: envPresent, value: envPresent ? config.delegate.autopilot.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → delegate.autopilot.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.delegate.autopilot.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- testTargeting.enabled ---
  {
    const envVal = env["DEEPCODER_TEST_TARGETING"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.testTargeting?.enabled !== undefined;
    add(
      "testTargeting.enabled",
      config.testTargeting.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_TEST_TARGETING" : filePresent ? `.deepcoder/config.json → testTargeting.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_TEST_TARGETING", present: envPresent, wins: envPresent, value: envPresent ? config.testTargeting.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → testTargeting.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.testTargeting.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- testTargeting.mode ---
  {
    const envVal = env["DEEPCODER_TEST_TARGETING"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.testTargeting?.mode !== undefined;
    add(
      "testTargeting.mode",
      config.testTargeting.mode,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_TEST_TARGETING" : filePresent ? `.deepcoder/config.json → testTargeting.mode` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_TEST_TARGETING", present: envPresent, wins: envPresent, value: envPresent ? config.testTargeting.mode : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → testTargeting.mode`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.testTargeting.mode : undefined },
        { source: "default", sourceRef: "hardcoded default (off)", present: true, wins: !envPresent && !filePresent, value: "off" },
      ],
    );
  }

  // --- semanticSearch.enabled ---
  {
    const envVal = env["DEEPCODER_SEMANTIC_SEARCH"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.semanticSearch?.enabled !== undefined;
    add(
      "semanticSearch.enabled",
      config.semanticSearch.enabled,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_SEMANTIC_SEARCH" : filePresent ? `.deepcoder/config.json → semanticSearch.enabled` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_SEMANTIC_SEARCH", present: envPresent, wins: envPresent, value: envPresent ? config.semanticSearch.enabled : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → semanticSearch.enabled`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.semanticSearch.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent && !filePresent, value: false },
      ],
    );
  }

  // --- web.enabled ---
  {
    const envVal = env["DEEPCODER_WEB"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "web.enabled",
      config.web.enabled,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_WEB" : "hardcoded default (false)",
      [
        { source: "env", sourceRef: "DEEPCODER_WEB", present: envPresent, wins: envPresent, value: envPresent ? config.web.enabled : undefined },
        { source: "default", sourceRef: "hardcoded default (false)", present: true, wins: !envPresent, value: false },
      ],
    );
  }

  // --- web.searchProvider ---
  {
    const envVal = env["DEEPCODER_WEB_SEARCH_PROVIDER"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    add(
      "web.searchProvider",
      config.web.searchProvider,
      envPresent ? "env" : "default",
      envPresent ? "DEEPCODER_WEB_SEARCH_PROVIDER" : "hardcoded default (none)",
      [
        { source: "env", sourceRef: "DEEPCODER_WEB_SEARCH_PROVIDER", present: envPresent, wins: envPresent, value: envPresent ? config.web.searchProvider : undefined },
        { source: "default", sourceRef: "hardcoded default (none)", present: true, wins: !envPresent, value: "none" },
      ],
    );
  }

  // --- telemetry.statusline ---
  {
    const envVal = env["DEEPCODER_STATUSLINE"] as string | undefined;
    const envPresent = envVal !== undefined && envVal !== "";
    const filePresent = file.telemetry?.statusline !== undefined;
    add(
      "telemetry.statusline",
      config.telemetry.statusline ?? true,
      envPresent ? "env" : filePresent ? "file" : "default",
      envPresent ? "DEEPCODER_STATUSLINE" : filePresent ? `.deepcoder/config.json → telemetry.statusline` : "hardcoded default",
      [
        { source: "env", sourceRef: "DEEPCODER_STATUSLINE", present: envPresent, wins: envPresent, value: envPresent ? config.telemetry.statusline : undefined },
        { source: "file", sourceRef: `.deepcoder/config.json → telemetry.statusline`, present: filePresent, wins: !envPresent && filePresent, value: filePresent ? config.telemetry.statusline : undefined },
        { source: "default", sourceRef: "hardcoded default (true)", present: true, wins: !envPresent && !filePresent, value: true },
      ],
    );
  }

  // --- telemetry.costs ---
  {
    const filePresent = file.telemetry?.costs !== undefined;
    add(
      "telemetry.costs",
      config.telemetry.costs ?? true,
      filePresent ? "file" : "default",
      filePresent ? `.deepcoder/config.json → telemetry.costs` : "hardcoded default",
      [
        { source: "file", sourceRef: `.deepcoder/config.json → telemetry.costs`, present: filePresent, wins: filePresent, value: filePresent ? config.telemetry.costs : undefined },
        { source: "default", sourceRef: "hardcoded default (true)", present: true, wins: !filePresent, value: true },
      ],
    );
  }

  // --- models.roles (count) ---
  {
    const roles = config.models?.roles;
    const count = roles ? Object.keys(roles).length : 0;
    add(
      "models.roles",
      count,
      count > 0 ? "file" : "default",
      count > 0 ? `.deepcoder/config.json → models.roles` : "no model roles configured",
      [
        { source: "file", sourceRef: ".deepcoder/config.json → models.roles", present: count > 0, wins: count > 0, value: count },
        { source: "default", sourceRef: "no model roles configured", present: count === 0, wins: count === 0, value: 0 },
      ],
    );
  }

  // Sort deterministically
  entries.sort((a, b) => a.key.localeCompare(b.key));

  return entries;
}

function envVsDefaultWithProvider(
  envVar: string,
  defaultValue: string | number | boolean | null,
  effectiveValue: string | number | boolean | null,
  env: NodeJS.ProcessEnv,
): { candidates: ConfigCandidate[]; winnerSource: ConfigSource; winnerRef: string } {
  const envVal = env[envVar] as string | undefined;
  const envPresent = envVal !== undefined && envVal !== "";
  const candidates: ConfigCandidate[] = [
    { source: "env", sourceRef: envVar, present: envPresent, wins: envPresent, value: envPresent ? effectiveValue : undefined },
    { source: "default", sourceRef: "hardcoded default", present: true, wins: !envPresent, value: defaultValue },
  ];
  return {
    candidates,
    winnerSource: envPresent ? "env" : "default",
    winnerRef: envPresent ? envVar : "hardcoded default",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a provenance report for the effective configuration.
 *
 * Pure: all seams (file loading, trust check) are injectable.
 */
export function buildDebugConfig(input: BuildDebugConfigInput): DebugConfigReport {
  const loadFile = input.loadFileConfig ?? defaultLoadFileConfig;
  const trustedFn = input.isWorkspaceTrusted ?? defaultIsWorkspaceTrusted;
  const file = loadFile(input.workspaceRoot);
  const trusted = trustedFn(input.workspaceRoot);
  const provider = input.config.provider;
  const prefix = PROVIDER_ENV_PREFIX[provider] ?? "";

  const fileHadMcp = Object.keys(file.mcpServers ?? {}).length > 0;
  const fileHadHooks = file.hooks?.enabled === true;

  const warnings: string[] = [];
  if (fileHadMcp && !trusted) {
    warnings.push("Workspace is not trusted; MCP servers from .deepcoder/config.json were disabled by trust-gate.");
  }
  if (fileHadHooks && !trusted) {
    warnings.push("Workspace is not trusted; hooks from .deepcoder/config.json were disabled by trust-gate.");
  }

  const ctx: BuildContext = {
    config: input.config,
    env: input.env,
    file,
    cliOverrides: input.cliOverrides,
    sessionOverrides: input.sessionOverrides,
    provider,
    prefix,
    trusted,
    fileHadMcp,
    fileHadHooks,
  };

  const entries = defineKeys(ctx);

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const SECTION_HEADERS: Record<string, string> = {
  sandbox: "Sandbox",
  web: "Web",
  delegate: "Delegate",
  skills: "Skills",
  context: "Context",
  dependencyHealing: "Dependency Healing",
  testTargeting: "Test Targeting",
  semanticSearch: "Semantic Search",
  telemetry: "Telemetry",
  models: "Models",
};

function sectionLabel(key: string): string | undefined {
  const top = key.split(".")[0];
  return SECTION_HEADERS[top];
}

/**
 * Format the report as a compact text summary.
 */
export function formatDebugConfig(
  report: DebugConfigReport,
  opts?: { section?: string },
): string {
  let entries = report.entries;

  if (opts?.section) {
    const section = opts.section.toLowerCase();
    entries = entries.filter((e) => {
      const top = e.key.split(".")[0];
      return top === section || e.key === section;
    });
    if (entries.length === 0) {
      return `Unknown config section "${opts.section}". Use /debug-config to list keys.`;
    }
  }

  const lines: string[] = [];
  lines.push("Config provenance");

  const sorted = [...entries];
  // group by section for nicer display
  const sections = new Map<string, DebugConfigEntry[]>();
  for (const entry of sorted) {
    const label = sectionLabel(entry.key) ?? "General";
    if (!sections.has(label)) sections.set(label, []);
    sections.get(label)!.push(entry);
  }

  for (const [, group] of sections) {
    for (const entry of group) {
      const raw = entry.value;
      const val = entry.redacted
        ? String(raw)
        : raw === null ? "null" : raw === undefined ? "" : JSON.stringify(raw);
      const line = `  ${entry.key.padEnd(30)} ${String(val).padEnd(20)} ${entry.source}: ${entry.sourceRef}`;
      lines.push(line);
    }
  }

  if (!opts?.section) {
    lines.push("");
    lines.push("Use /debug-config why <key> for details.");
  }

  return lines.join("\n");
}

/**
 * Format a detailed provenance chain for a single key.
 */
export function formatDebugConfigWhy(
  report: DebugConfigReport,
  key: string,
): string {
  const entry = report.entries.find((e) => e.key === key);
  if (!entry) {
    return `Unknown config key "${key}". Use /debug-config to list keys.`;
  }

  const lines: string[] = [];
  const raw = entry.value;
  const val = entry.redacted ? String(raw) : raw === null ? "null" : raw === undefined ? "" : JSON.stringify(raw);
  lines.push(`${entry.key} = ${val}`);
  lines.push(`winner: ${entry.source} → ${entry.sourceRef}`);

  lines.push("precedence:");
  for (const cand of entry.candidates) {
    const cv = cand.value;
    const valStr = cand.redacted
      ? String(cv ?? "<unset>")
      : cand.present
        ? (cv === null ? "null" : cv === undefined ? "unset" : JSON.stringify(cv))
        : "unset";
    const arrow = cand.wins ? " ←" : "";
    const ref = cand.sourceRef.padEnd(45);
    lines.push(`  ${cand.source.padEnd(12)} ${ref} ${valStr}${arrow}`);
  }

  if (entry.notes && entry.notes.length > 0) {
    lines.push("notes:");
    for (const note of entry.notes) {
      lines.push(`  ${note}`);
    }
  }

  return lines.join("\n");
}
