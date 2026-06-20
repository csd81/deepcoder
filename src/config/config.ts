import "dotenv/config";
import { loadFileConfig, type McpServerConfig, type CheckConfig } from "./fileConfig.js";
import { isWorkspaceTrusted } from "./trust.js";
import { DEFAULT_SANDBOX, type SandboxConfig, type SandboxMode } from "../sandbox/types.js";
import {
  DEFAULT_WORKSPACE_ISOLATION,
  type WorkspaceIsolationConfig,
  type WorkspaceIsolationMode,
} from "../workspaceIsolation/types.js";
import { DEFAULT_HOOKS, type HooksConfig } from "../hooks/types.js";
import type { ModelsFileConfig } from "../models/types.js";

const SANDBOX_MODES: SandboxMode[] = [
  "off", "fast", "local", "bubblewrap", "sandbox-exec", "docker", "podman", "runsc",
];
const WS_ISOLATION_MODES: WorkspaceIsolationMode[] = ["off", "patch", "keep"];

export type ApprovalMode = "ask" | "auto" | "readonly";
export type CheckpointMode = "off" | "manual" | "auto";

/** Phase 8E semantic-search settings (opt-in; default disabled). */
export interface SemanticSearchConfig {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  dimensions: number | null;
  hybridLexicalWeight: number;
  topK: number;
}

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
  /** Phase 8E opt-in semantic search (default disabled). */
  semanticSearch: SemanticSearchConfig;
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
  skills: SkillsConfig;
  dependencyHealing: DependencyHealingConfig;
  delegate: DelegateConfig;
  testTargeting: TestTargetingConfig;
  /** Phase 10F — model/task router config (optional). */
  models?: ModelsFileConfig;
}

export interface QualityGateOptions {
  enabled: boolean;
  mode: "mandatory" | "advisory";
  blockOnReviewerError: boolean;
  minimumBlockingSeverity: "critical" | "high" | "medium" | "low";
  maxPatchBytes: number;
  maxContextBytes: number;
}

export interface DelegateConfig {
  qualityGate: QualityGateOptions;
}

export type TestTargetingMode = "off" | "suggest" | "targeted-first" | "targeted-only";

export interface TestTargetingConfig {
  enabled: boolean;
  mode: TestTargetingMode;
  fallbackCheck: string;
  maxTargets: number;
  minConfidence: "high" | "medium" | "low" | "none";
  runFullAfterTargetedPass: boolean;
  languageCommands: Record<string, string>;
  pathRules: { changed: string; tests: string[] }[];
}

export const DEFAULT_TEST_TARGETING: TestTargetingConfig = {
  enabled: false,
  mode: "off",
  fallbackCheck: "phase",
  maxTargets: 8,
  minConfidence: "medium",
  runFullAfterTargetedPass: false,
  languageCommands: {
    typescript: "node --import tsx --test {files}",
    javascript: "node --test {files}",
    python: "python -m pytest -q {files}",
  },
  pathRules: [{ changed: "src/**", tests: ["test/**/*.test.ts"] }],
};

export const DEFAULT_QUALITY_GATE: QualityGateOptions = {
  enabled: false,
  mode: "mandatory",
  blockOnReviewerError: true,
  minimumBlockingSeverity: "high",
  maxPatchBytes: 80000,
  maxContextBytes: 24000,
};

export interface DependencyHealingConfig {
  enabled: boolean;
  network: "on" | "off";
  maxAttempts: number;
  allowPackageScripts: boolean;
  managers: string[];
  preferFrozenLockfile: boolean;
  timeoutMs: number;
}

export const DEFAULT_DEPENDENCY_HEALING: DependencyHealingConfig = {
  enabled: false,
  network: "off",
  maxAttempts: 1,
  allowPackageScripts: false,
  managers: ["npm", "pnpm", "yarn", "pip"],
  preferFrozenLockfile: true,
  timeoutMs: 300000,
};

export interface SkillsConfig {
  enabled: boolean;
  trustWorkspaceSkills: boolean;
  catalogMaxChars: number;
  activationMaxBytes: number;
  disabled: string[];
}

const DEFAULT_SKILLS: SkillsConfig = {
  enabled: true,
  trustWorkspaceSkills: false,
  catalogMaxChars: 4000,
  activationMaxBytes: 65536,
  disabled: [],
};

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
  // Default Gemini: 3.1 Pro (preview). 3.x works now that the provider
  // captures/replays Gemini's thought_signature in the tool loop.
  gemini: "gemini-3.1-pro-preview",
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

export type ConfigOverrides = Partial<Omit<Config, "sandbox" | "workspaceIsolation" | "hooks" | "skills" | "dependencyHealing" | "delegate">> & {
  sandbox?: Partial<SandboxConfig>;
  workspaceIsolation?: Partial<WorkspaceIsolationConfig>;
  hooks?: Partial<HooksConfig>;
  context?: Partial<ContextConfig>;
  skills?: Partial<SkillsConfig>;
  dependencyHealing?: Partial<DependencyHealingConfig>;
  delegate?: { qualityGate?: Partial<QualityGateOptions> };
};

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const { sandbox: sandboxOverride, workspaceIsolation: wsIsoOverride, delegate: delegateOverride, ...rest } = overrides;
  const approval = (process.env.DEEPCODER_APPROVAL_MODE as ApprovalMode) || "ask";
  const workspaceRoot = overrides.workspaceRoot ?? process.cwd();
  const file = loadFileConfig(workspaceRoot);

  // Trust gate (security): a workspace's `.deepcoder/config.json` can define MCP
  // servers (spawned at startup) and hooks (run on session events) that EXECUTE
  // CODE before the user approves anything. Do NOT honour those from an untrusted
  // workspace — neutralize them unless the workspace is explicitly trusted.
  if (!isWorkspaceTrusted(workspaceRoot)) {
    const hadMcp = Object.keys(file.mcpServers ?? {}).length > 0;
    const hadHooks = file.hooks?.enabled === true;
    if (hadMcp || hadHooks) {
      const what = [hadMcp ? "MCP servers" : "", hadHooks ? "hooks" : ""].filter(Boolean).join(" and ");
      process.stderr.write(
        `Warning: this workspace's .deepcoder/config.json defines ${what} that execute code. ` +
          `They are DISABLED because the workspace is not trusted. ` +
          `Set DEEPCODER_TRUST_WORKSPACE=1 (or add the path to ~/.deepcoder/trusted-workspaces) to enable.\n`,
      );
    }
    file.mcpServers = {};
    file.hooks = { enabled: false };
  }

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

  // Skills: default < config file < env gate.
  const skillsEnv = process.env.DEEPCODER_SKILLS;
  const trustWorkspaceEnv = process.env.DEEPCODER_SKILLS_TRUST_WORKSPACE;
  const catalogCharsEnv = process.env.DEEPCODER_SKILLS_CATALOG_CHARS;
  const activationBytesEnv = process.env.DEEPCODER_SKILLS_ACTIVATION_BYTES;

  const fileSkills = file.skills ?? {};

  const skills: SkillsConfig = {
    enabled: skillsEnv !== undefined
      ? ["1", "true", "yes"].includes(skillsEnv.toLowerCase())
      : (fileSkills.enabled ?? DEFAULT_SKILLS.enabled),
    trustWorkspaceSkills: trustWorkspaceEnv !== undefined
      ? ["1", "true", "yes"].includes(trustWorkspaceEnv.toLowerCase())
      : (fileSkills.trustWorkspaceSkills ?? DEFAULT_SKILLS.trustWorkspaceSkills),
    catalogMaxChars: catalogCharsEnv !== undefined
      ? numEnv(catalogCharsEnv, DEFAULT_SKILLS.catalogMaxChars)
      : (fileSkills.catalogMaxChars ?? DEFAULT_SKILLS.catalogMaxChars),
    activationMaxBytes: activationBytesEnv !== undefined
      ? numEnv(activationBytesEnv, DEFAULT_SKILLS.activationMaxBytes)
      : (fileSkills.activationMaxBytes ?? DEFAULT_SKILLS.activationMaxBytes),
    disabled: fileSkills.disabled ?? DEFAULT_SKILLS.disabled,
  };

  const fileDepHealing = file.dependencyHealing ?? {};
  const depHealingEnv = process.env.DEEPCODER_DEP_HEALING;
  const depHealingNetworkEnv = process.env.DEEPCODER_DEP_HEALING_NETWORK;

  const dependencyHealing: DependencyHealingConfig = {
    enabled: depHealingEnv !== undefined
      ? ["1", "true", "yes"].includes(depHealingEnv.toLowerCase())
      : (fileDepHealing.enabled ?? DEFAULT_DEPENDENCY_HEALING.enabled),
    network: depHealingNetworkEnv !== undefined && ["on", "off"].includes(depHealingNetworkEnv.toLowerCase())
      ? (depHealingNetworkEnv.toLowerCase() as "on" | "off")
      : (fileDepHealing.network ?? DEFAULT_DEPENDENCY_HEALING.network),
    maxAttempts: fileDepHealing.maxAttempts ?? DEFAULT_DEPENDENCY_HEALING.maxAttempts,
    allowPackageScripts: fileDepHealing.allowPackageScripts ?? DEFAULT_DEPENDENCY_HEALING.allowPackageScripts,
    managers: fileDepHealing.managers ?? DEFAULT_DEPENDENCY_HEALING.managers,
    preferFrozenLockfile: fileDepHealing.preferFrozenLockfile ?? DEFAULT_DEPENDENCY_HEALING.preferFrozenLockfile,
    timeoutMs: fileDepHealing.timeoutMs ?? DEFAULT_DEPENDENCY_HEALING.timeoutMs,
  };

  const fileDelegate = (file.delegate ?? {}) as Partial<DelegateConfig>;
  const fileQualityGate = (fileDelegate.qualityGate ?? {}) as Partial<QualityGateOptions>;
  const overrideQualityGate = delegateOverride?.qualityGate ?? {};

  const qgEnabledEnv = process.env.DEEPCODER_DELEGATE_QUALITY_GATE;
  const qgBlockOnErrorEnv = process.env.DEEPCODER_DELEGATE_QUALITY_GATE_BLOCK_ON_ERROR;

  const qualityGate: QualityGateOptions = {
    enabled: overrideQualityGate.enabled !== undefined
      ? overrideQualityGate.enabled
      : (qgEnabledEnv !== undefined
        ? ["1", "true", "yes"].includes(qgEnabledEnv.toLowerCase())
        : (fileQualityGate.enabled ?? DEFAULT_QUALITY_GATE.enabled)),
    mode: overrideQualityGate.mode ?? fileQualityGate.mode ?? DEFAULT_QUALITY_GATE.mode,
    blockOnReviewerError: overrideQualityGate.blockOnReviewerError !== undefined
      ? overrideQualityGate.blockOnReviewerError
      : (qgBlockOnErrorEnv !== undefined
        ? ["1", "true", "yes"].includes(qgBlockOnErrorEnv.toLowerCase())
        : (fileQualityGate.blockOnReviewerError ?? DEFAULT_QUALITY_GATE.blockOnReviewerError)),
    minimumBlockingSeverity: overrideQualityGate.minimumBlockingSeverity ?? fileQualityGate.minimumBlockingSeverity ?? DEFAULT_QUALITY_GATE.minimumBlockingSeverity,
    maxPatchBytes: overrideQualityGate.maxPatchBytes ?? fileQualityGate.maxPatchBytes ?? DEFAULT_QUALITY_GATE.maxPatchBytes,
    maxContextBytes: overrideQualityGate.maxContextBytes ?? fileQualityGate.maxContextBytes ?? DEFAULT_QUALITY_GATE.maxContextBytes,
  };

  const delegate: DelegateConfig = {
    qualityGate,
  };

  // Phase 10H — test targeting config: default < file < env.
  const fileTestTargeting = file.testTargeting ?? {};
  const ttEnv = (process.env.DEEPCODER_TEST_TARGETING ?? "").toLowerCase();
  const testTargeting: TestTargetingConfig = {
    enabled: ttEnv !== ""
      ? ["1", "true", "yes", "suggest", "targeted-first", "targeted-only"].includes(ttEnv)
      : (fileTestTargeting.enabled ?? DEFAULT_TEST_TARGETING.enabled),
    mode: ttEnv !== "" && ["off", "suggest", "targeted-first", "targeted-only"].includes(ttEnv)
      ? (ttEnv as TestTargetingMode)
      : (fileTestTargeting.mode ?? DEFAULT_TEST_TARGETING.mode),
    fallbackCheck: fileTestTargeting.fallbackCheck ?? DEFAULT_TEST_TARGETING.fallbackCheck,
    maxTargets: fileTestTargeting.maxTargets ?? DEFAULT_TEST_TARGETING.maxTargets,
    minConfidence: fileTestTargeting.minConfidence ?? DEFAULT_TEST_TARGETING.minConfidence,
    runFullAfterTargetedPass: fileTestTargeting.runFullAfterTargetedPass ?? DEFAULT_TEST_TARGETING.runFullAfterTargetedPass,
    languageCommands: fileTestTargeting.languageCommands ?? DEFAULT_TEST_TARGETING.languageCommands,
    pathRules: fileTestTargeting.pathRules ?? DEFAULT_TEST_TARGETING.pathRules,
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

  // Phase 8E semantic search: opt-in (default off). fileConfig provides the
  // block; env can flip enabled/provider/model.
  const ss = (file as { semanticSearch?: Partial<SemanticSearchConfig> }).semanticSearch ?? {};
  const semanticSearch: SemanticSearchConfig = {
    enabled:
      ["1", "true", "yes"].includes((process.env.DEEPCODER_SEMANTIC_SEARCH ?? "").toLowerCase()) ||
      ss.enabled === true,
    provider: process.env.DEEPCODER_EMBEDDING_PROVIDER ?? ss.provider ?? "ollama",
    model: process.env.DEEPCODER_EMBEDDING_MODEL ?? ss.model ?? "nomic-embed-text",
    baseUrl: ss.baseUrl ?? "http://localhost:11434",
    dimensions: typeof ss.dimensions === "number" ? ss.dimensions : null,
    hybridLexicalWeight: typeof ss.hybridLexicalWeight === "number" ? ss.hybridLexicalWeight : 0.35,
    topK: typeof ss.topK === "number" && ss.topK > 0 ? ss.topK : 12,
  };

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature,
    reasoningEffort,
    semanticSearch,
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
    skills: { ...skills, ...(overrides.skills ?? {}) },
    dependencyHealing: { ...dependencyHealing, ...(overrides.dependencyHealing ?? {}) },
    delegate,
    testTargeting,
    models: file.models,
  };
}
