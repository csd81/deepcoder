import "dotenv/config";
import { loadFileConfig, type McpServerConfig, type CheckConfig } from "./fileConfig.js";
import { DEFAULT_SANDBOX, type SandboxConfig, type SandboxMode } from "../sandbox/types.js";
import {
  DEFAULT_WORKSPACE_ISOLATION,
  type WorkspaceIsolationConfig,
  type WorkspaceIsolationMode,
} from "../workspaceIsolation/types.js";
import { DEFAULT_HOOKS, type HooksConfig } from "../hooks/types.js";

const SANDBOX_MODES: SandboxMode[] = [
  "off", "fast", "local", "bubblewrap", "sandbox-exec", "docker", "podman", "runsc",
];
const WS_ISOLATION_MODES: WorkspaceIsolationMode[] = ["off", "patch", "keep"];

export type ApprovalMode = "ask" | "auto" | "readonly";
export type CheckpointMode = "off" | "manual" | "auto";

export interface Config {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasonerModel?: string;
  /**
   * Sampling temperature sent to the provider. Defaults to 0 (deterministic).
   * `undefined` means OMIT the field entirely so the model uses its own default
   * — required by GPT-5 reasoning models, which reject a non-default temperature.
   * Set via DEEPCODER_TEMPERATURE (a number, or "default"/"omit" to omit).
   */
  temperature?: number;
  /** Reasoning effort for reasoning providers (openai-responses). Default "medium". */
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * When true, a one-shot run first asks the reasoner model for a step-by-step
   * plan (no tools), prepends it as context, then runs the normal agent loop.
   * Lets a stronger reasoning model guide a cheaper editing model.
   */
  planFirst?: boolean;
  /** Closed-loop solve mode: edit → run `solveCheck` → retry on failure. */
  solve?: boolean;
  /** Name of the configured check to verify with in solve mode. */
  solveCheck?: string;
  /** Maximum edit→verify attempts in solve mode. */
  solveMaxAttempts: number;
  /**
   * Phase 5C — repro-test generation in solve mode. "auto" lets the solver write
   * its own failing test (the oracle when no check is configured, else an extra
   * regression artifact). Default "off" — zero change to existing solve runs.
   */
  solveRepro?: "auto" | "off";
  /** Workspace-relative path for the generated repro test (default: a scratch path). */
  solveReproPath?: string;
  /**
   * When set (headless eval only), the solver writes a machine-readable
   * telemetry JSON of the run to this path: per-attempt check exit/timeout,
   * a patch hash (to detect repeated edits) and the bounded failure summary.
   * Interactive use leaves this unset.
   */
  solveTelemetry?: string;
  /** Model used by read-only review subagents; defaults to `model` when unset. */
  subagentModel?: string;
  maxTurns: number;
  approvalMode: ApprovalMode;
  /** Approximate token budget before history compaction kicks in. */
  contextBudgetTokens: number;
  /** Fraction of the budget at which compaction triggers. */
  compactAt: number;
  /** Local checkpoint/undo mode (not git): off | manual | auto. */
  checkpoints: CheckpointMode;
  /** Absolute path the agent is allowed to operate within. */
  workspaceRoot: string;
  /** MCP servers from .deepcoder/config.json (empty if none configured). */
  mcpServers: Record<string, McpServerConfig>;
  /** Named verification checks from .deepcoder/config.json (user-invoked only). */
  checks: Record<string, CheckConfig>;
  /**
   * Whether execute-kind MCP tools may run. Off in Phase 4A — execute-mode MCP
   * tools are discovered but denied until a later phase enables them.
   */
  mcpExecuteEnabled: boolean;
  /**
   * Sandbox policy for risky tool executions (run_bash, configured checks).
   * Precedence: CLI `--sandbox` > `DEEPCODER_SANDBOX` env > config file > default `fast`.
   */
  sandbox: SandboxConfig;
  /**
   * Workspace isolation policy. When not "off", agent file edits + checks run in
   * a disposable git worktree (execution plane); config/sessions stay on the real
   * root (control plane). Precedence: `--workspace-isolation` > env > file > off.
   */
  workspaceIsolation: WorkspaceIsolationConfig;
  /**
   * Lifecycle hooks configuration. Disabled by default. When enabled, matching
   * hooks run before each tool use (PreToolUse) and can deny the action.
   */
  hooks: HooksConfig;
  /**
   * Phase 8A — instruction graph. When `instructionGraph` is true, project
   * instructions load through the inspectable hierarchical graph (global +
   * workspace→cwd walk + safe `@imports` + JIT path-local rules) instead of the
   * legacy first-match loader. Off by default (gate: DEEPCODER_INSTRUCTION_GRAPH=1).
   */
  context: ContextConfig;
}

export interface ContextConfig {
  instructionGraph: boolean;
  instructionImports: boolean;
  instructionImportMaxDepth: number;
  instructionImportMaxBytes: number;
  /**
   * Phase 8D — preflight context gathering. When true, before solve attempt 1
   * the solver builds a context plan, runs the read-only explorer subagent, and
   * injects a compact advisory brief into the conversation. Opt-in only (default
   * false). Gated by DEEPCODER_CONTEXT_PREFLIGHT env var (1/true/yes on,
   * 0/false/no off), following the instructionGraph env pattern.
   */
  preflight: boolean;
  /** Maximum bytes for the rendered preflight brief (default 6000). */
  preflightMaxBytes: number;
  /** Maximum turns for the explorer subagent during preflight (default 8). */
  explorerMaxTurns: number;
}

const DEFAULT_CONTEXT: ContextConfig = {
  instructionGraph: false,
  instructionImports: true,
  instructionImportMaxDepth: 4,
  instructionImportMaxBytes: 65_536,
  preflight: false,
  preflightMaxBytes: 6000,
  explorerMaxTurns: 8,
};

/** Parse a numeric env var, falling back to `fallback` for unset/invalid values. */
function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function req(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required config "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  deepseek: "deepseek-chat",
  ollama: "llama3.1",
  "openai-compatible": "gpt-4o-mini",
  "openai-responses": "gpt-5.3-codex",
  qwen: "qwen2.5-coder-32b-instruct",
  // Newest Gemini that works with deepcoder's tool loop: the 3.x models (3.5-flash,
  // flash-latest) 400 on multi-turn tool use ("missing thought_signature", a
  // Gemini extension the OpenAI-compat format doesn't carry), so 2.5-flash stands.
  gemini: "gemini-2.5-flash",
  anthropic: "claude-3-5-sonnet-latest",
};

const KNOWN_PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULT_MODELS));

/**
 * Per-provider env-var prefix. Each provider resolves its key/baseUrl/model from
 * its OWN prefix only (e.g. `OPENAI_API_KEY` for openai-compatible), so multiple
 * providers' credentials can live in `.env` uncommented at the same time and
 * `DEEPCODER_PROVIDER` selects which one is active. A prefix never bleeds across
 * providers (a stray `DEEPSEEK_*` cannot satisfy openai-compatible).
 */
const PROVIDER_ENV_PREFIX: Record<string, string> = {
  deepseek: "DEEPSEEK",
  ollama: "OLLAMA",
  "openai-compatible": "OPENAI",
  "openai-responses": "OPENAI",
  qwen: "QWEN",
  gemini: "GEMINI",
  anthropic: "ANTHROPIC",
};

export type ConfigOverrides = Partial<Omit<Config, "sandbox" | "workspaceIsolation" | "hooks">> & {
  sandbox?: Partial<SandboxConfig>;
  workspaceIsolation?: Partial<WorkspaceIsolationConfig>;
  hooks?: Partial<HooksConfig>;
  context?: Partial<ContextConfig>;
};

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const { sandbox: sandboxOverride, workspaceIsolation: wsIsoOverride, ...rest } = overrides;
  const approval = (process.env.DEEPCODER_APPROVAL_MODE as ApprovalMode) || "ask";
  const workspaceRoot = overrides.workspaceRoot ?? process.cwd();
  const file = loadFileConfig(workspaceRoot);

  // Sandbox: default < config file < env < CLI override (applied last via overrides).
  const envMode = (process.env.DEEPCODER_SANDBOX || "").toLowerCase();
  const sandbox: SandboxConfig = {
    ...DEFAULT_SANDBOX,
    ...(file.sandbox ?? {}),
    ...(SANDBOX_MODES.includes(envMode as SandboxMode) ? { mode: envMode as SandboxMode } : {}),
  };

  const envIso = (process.env.DEEPCODER_WORKSPACE_ISOLATION || "").toLowerCase();
  const workspaceIsolation: WorkspaceIsolationConfig = {
    ...DEFAULT_WORKSPACE_ISOLATION,
    ...(file.workspaceIsolation ?? {}),
    ...(WS_ISOLATION_MODES.includes(envIso as WorkspaceIsolationMode) ? { mode: envIso as WorkspaceIsolationMode } : {}),
  };

  // Hooks: default < config file < CLI override (applied last via overrides).
  const hooks: HooksConfig = {
    ...DEFAULT_HOOKS,
    ...(file.hooks ?? {}),
  };

  // Context/instruction-graph: default < config file < env gate.
  const igEnv = (process.env.DEEPCODER_INSTRUCTION_GRAPH ?? "").toLowerCase();
  const pfEnv = (process.env.DEEPCODER_CONTEXT_PREFLIGHT ?? "").toLowerCase();
  const context: ContextConfig = {
    ...DEFAULT_CONTEXT,
    ...(file.context ?? {}),
    ...(["1", "true", "yes"].includes(igEnv) ? { instructionGraph: true } : {}),
    ...(["0", "false", "no"].includes(igEnv) ? { instructionGraph: false } : {}),
    ...(["1", "true", "yes"].includes(pfEnv) ? { preflight: true } : {}),
    ...(["0", "false", "no"].includes(pfEnv) ? { preflight: false } : {}),
  };

  const provider = (process.env.DEEPCODER_PROVIDER || "deepseek").toLowerCase();
  // Validate the provider BEFORE requiring a key, so a typo'd provider reports
  // "unknown provider" rather than a misleading "missing API key".
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider "${provider}". Use deepseek | openai-compatible | ollama.`);
  }

  // Resolve credentials from the selected provider's OWN prefix (DEEPSEEK_*,
  // OPENAI_*, GEMINI_*, …). Explicit DEEPCODER_* always wins; a provider never
  // reads another provider's prefix, so DEEPSEEK_* can't silently satisfy
  // openai-compatible. This lets every provider's keys stay uncommented in .env.
  const prefix = PROVIDER_ENV_PREFIX[provider];
  const providerEnv = (suffix: string): string | undefined =>
    prefix ? process.env[`${prefix}_${suffix}`] : undefined;

  const apiKeyRaw = process.env.DEEPCODER_API_KEY ?? providerEnv("API_KEY");
  // Ollama runs locally and ignores the key, so it isn't required there.
  const apiKey = provider === "ollama" ? apiKeyRaw ?? "" : req("API key (DEEPCODER_API_KEY)", apiKeyRaw);
  const baseUrl = process.env.DEEPCODER_BASE_URL ?? providerEnv("BASE_URL") ?? "";
  const model =
    process.env.DEEPCODER_MODEL ?? providerEnv("MODEL") ?? PROVIDER_DEFAULT_MODELS[provider] ?? "deepseek-chat";

  // Temperature: a number, or omitted ("default"/"omit"/"none") so reasoning
  // models can use their own default. Unset → 0 (deterministic, back-compat).
  const tempRaw = process.env.DEEPCODER_TEMPERATURE;
  let temperature: number | undefined;
  if (tempRaw === undefined || tempRaw === "") temperature = 0;
  else if (/^(default|omit|none)$/i.test(tempRaw)) temperature = undefined;
  else {
    const n = Number(tempRaw);
    temperature = Number.isFinite(n) ? n : 0;
  }

  const reEff = (process.env.DEEPCODER_REASONING_EFFORT ?? "").toLowerCase();
  const reasoningEffort = (["low", "medium", "high"].includes(reEff) ? reEff : "medium") as
    | "low"
    | "medium"
    | "high";

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature,
    reasoningEffort,
    reasonerModel: process.env.DEEPCODER_REASONER_MODEL ?? providerEnv("REASONER_MODEL"),
    planFirst:
      ["1", "true", "yes"].includes((process.env.DEEPCODER_PLAN_FIRST ?? "").toLowerCase()) ||
      ["1", "true", "yes"].includes((process.env.DEEPCODER_SOLVE_PLAN_FIRST ?? "").toLowerCase()),
    solveCheck: process.env.DEEPCODER_SOLVE_CHECK || undefined,
    solveMaxAttempts: Math.max(1, Math.trunc(numEnv(process.env.DEEPCODER_SOLVE_MAX_ATTEMPTS, 3))),
    solveRepro: process.env.DEEPCODER_SOLVE_REPRO === "auto" ? "auto" : undefined,
    solveReproPath: process.env.DEEPCODER_SOLVE_REPRO_PATH || undefined,
    solveTelemetry: process.env.DEEPCODER_SOLVE_TELEMETRY || undefined,
    subagentModel: process.env.DEEPCODER_SUBAGENT_MODEL,
    maxTurns: numEnv(process.env.DEEPCODER_MAX_TURNS, 20),
    approvalMode: approval,
    contextBudgetTokens: numEnv(process.env.DEEPCODER_CONTEXT_BUDGET_TOKENS, 64000),
    compactAt: numEnv(process.env.DEEPCODER_COMPACT_AT, 0.8),
    checkpoints: (["off", "manual", "auto"].includes(process.env.DEEPCODER_CHECKPOINTS ?? "")
      ? (process.env.DEEPCODER_CHECKPOINTS as CheckpointMode)
      : "off"),
    workspaceRoot,
    mcpServers: file.mcpServers ?? {},
    checks: file.checks ?? {},
    mcpExecuteEnabled: false, // Phase 4A: execute-mode MCP tools are denied
    ...rest,
    // A CLI partial (e.g. {mode}) layers on top of the file/env-resolved sandbox
    // rather than replacing it wholesale.
    sandbox: { ...sandbox, ...(sandboxOverride ?? {}) },
    workspaceIsolation: { ...workspaceIsolation, ...(wsIsoOverride ?? {}) },
    hooks: { ...hooks, ...(overrides.hooks ?? {}) },
    context: { ...context, ...(overrides.context ?? {}) },
  };
}
