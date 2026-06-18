import "dotenv/config";
import { loadFileConfig, type McpServerConfig, type CheckConfig } from "./fileConfig.js";

export type ApprovalMode = "ask" | "auto" | "readonly";
export type CheckpointMode = "off" | "manual" | "auto";

export interface Config {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasonerModel?: string;
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
}

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
  qwen: "qwen2.5-coder-32b-instruct",
  gemini: "gemini-2.0-flash",
  anthropic: "claude-3-5-sonnet-latest",
};

const KNOWN_PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULT_MODELS));

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const approval = (process.env.DEEPCODER_APPROVAL_MODE as ApprovalMode) || "ask";
  const workspaceRoot = overrides.workspaceRoot ?? process.cwd();
  const file = loadFileConfig(workspaceRoot);

  const provider = (process.env.DEEPCODER_PROVIDER || "deepseek").toLowerCase();
  // Validate the provider BEFORE requiring a key, so a typo'd provider reports
  // "unknown provider" rather than a misleading "missing API key".
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider "${provider}". Use deepseek | openai-compatible | ollama.`);
  }

  // DEEPSEEK_* are aliases ONLY for the deepseek provider — they must not bleed
  // into ollama/openai-compatible (which would silently target DeepSeek).
  const alias = <T>(v: T): T | undefined => (provider === "deepseek" ? v : undefined);
  const apiKeyRaw = process.env.DEEPCODER_API_KEY ?? alias(process.env.DEEPSEEK_API_KEY);
  // Ollama runs locally and ignores the key, so it isn't required there.
  const apiKey = provider === "ollama" ? apiKeyRaw ?? "" : req("API key (DEEPCODER_API_KEY)", apiKeyRaw);
  const baseUrl = process.env.DEEPCODER_BASE_URL ?? alias(process.env.DEEPSEEK_BASE_URL) ?? "";
  const model =
    process.env.DEEPCODER_MODEL ?? alias(process.env.DEEPSEEK_MODEL) ?? PROVIDER_DEFAULT_MODELS[provider] ?? "deepseek-chat";

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    reasonerModel: process.env.DEEPCODER_REASONER_MODEL ?? alias(process.env.DEEPSEEK_REASONER_MODEL),
    planFirst:
      ["1", "true", "yes"].includes((process.env.DEEPCODER_PLAN_FIRST ?? "").toLowerCase()) ||
      ["1", "true", "yes"].includes((process.env.DEEPCODER_SOLVE_PLAN_FIRST ?? "").toLowerCase()),
    solveCheck: process.env.DEEPCODER_SOLVE_CHECK || undefined,
    solveMaxAttempts: Math.max(1, Math.trunc(numEnv(process.env.DEEPCODER_SOLVE_MAX_ATTEMPTS, 3))),
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
    ...overrides,
  };
}
