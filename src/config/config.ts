import "dotenv/config";
import { loadFileConfig, type McpServerConfig, type CheckConfig, type UserCommandConfig, type TelemetryConfig, type StatuslineConfig, type FormatConfig } from "./fileConfig.js";
import { isWorkspaceTrusted } from "./trust.js";
import { DEFAULT_SANDBOX, type SandboxConfig, type SandboxMode } from "../sandbox/types.js";
import { DEFAULT_CONTAINMENT, applyContainment, type ContainmentConfig } from "../containment/types.js";
import {
  DEFAULT_WORKSPACE_ISOLATION,
  type WorkspaceIsolationConfig,
  type WorkspaceIsolationMode,
} from "../workspaceIsolation/types.js";
import { DEFAULT_HOOKS, type HooksConfig } from "../hooks/types.js";
import type { ModelsFileConfig } from "../models/types.js";
import { DEFAULT_DIAGNOSTICS, type DiagnosticsConfig } from "../diagnostics/types.js";
import { webConfigFromEnv, type WebConfig } from "./webConfig.js";
import type { LspConfig } from "../lsp/types.js";
import { resolveKeybinds, type KeybindsConfig } from "../ui/keybinds.js";

const SANDBOX_MODES: SandboxMode[] = [
  "off", "fast", "local", "bubblewrap", "sandbox-exec", "docker", "podman", "runsc",
];
const WS_ISOLATION_MODES: WorkspaceIsolationMode[] = ["off", "patch", "keep"];

export type ApprovalMode = "ask" | "auto" | "readonly" | "yolo";
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
  /** Phase 10E opt-in web tools (default disabled). */
  web: WebConfig;
  /** Opt-in LSP code-intelligence tools (default disabled). */
  lsp: LspConfig;
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
  /** User-defined slash commands from .deepcoder/config.json. */
  commands: Record<string, UserCommandConfig>;
  /**
   * Whether execute-kind MCP tools may run. Off in Phase 4A — execute-mode MCP
   * tools are discovered but denied until a later phase enables them.
   */
  mcpExecuteEnabled: boolean;
  /**
   * Phase 10G — whether the persistent interactive-shell tool (`run_in_shell`) is
   * exposed to the model. Default-off / fail-closed: a long-lived stateful shell
   * is a powerful capability, so it must be opted in via DEEPCODER_INTERACTIVE_SHELL.
   * When on, the tool still flows through the command permission policy.
   */
  interactiveShell: boolean;
  /**
   * Sandbox policy for risky tool executions (run_bash, configured checks).
   * Precedence: CLI `--sandbox` > `DEEPCODER_SANDBOX` env > config file > default `fast`.
   */
  sandbox: SandboxConfig;
  /** Phase 10S — workspace containment (fail-closed, default ON). When enabled,
   *  `sandbox` is rewritten to a workspace-only bubblewrap profile. */
  containment: ContainmentConfig;
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
   * Phase 7I — post-write diagnostic interceptor. DEFAULT DISABLED. When
   * enabled, after a successful mutating tool (edit_file/write_file) the agent
   * runs matching diagnostic commands and feeds bounded output back to the
   * model. Command is CONFIG-defined (never model-defined), classifier-gated,
   * sandboxed, redacted, and capped. No auto-fix in v1.
   */
  diagnostics: DiagnosticsConfig;
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
  /** Resolved key bindings (DEFAULTS merged with .deepcoder/config.json `keybinds`). */
  keybinds: KeybindsConfig;
  /** Phase 10F — model/task router config (optional). */
  models?: ModelsFileConfig;
  /** Configurable statusline fields (default: all fields, in default order). */
  statusline?: StatuslineConfig;
  /** Phase 10C — telemetry configuration (statusline, costs, pricing overrides). */
  telemetry: TelemetryConfig;
  /** Format-on-edit config (opt-in). null = not configured. */
  format: FormatConfig | null;
  /** PR context for injecting the diff into a session's initial messages. */
  prContext?: PrContext;
}

/** PR context injected into the session startup (from `--pr` or `/pr`). */
export interface PrContext {
  number: string;
  diff: string;
  prBranch: string;
}

export interface QualityGateOptions {
  enabled: boolean;
  mode: "mandatory" | "advisory";
  blockOnReviewerError: boolean;
  minimumBlockingSeverity: "critical" | "high" | "medium" | "low";
  maxPatchBytes: number;
  maxContextBytes: number;
}

export interface AcceptanceFirstOptions {
  /** When on, delegated workers must ship a validated red→green test + a production change. */
  enabled: boolean;
}

export interface DelegateAutopilotConfig {
  /** Master switch — default OFF. When false, /delegate autopilot refuses. */
  enabled: boolean;
  /** Maximum number of orchestration rounds (total, not retries). */
  maxRounds: number;
  /** Maximum number of workers in the plan. */
  maxWorkers: number;
  /** Maximum number of workers to run concurrently. */
  maxConcurrency: number;
  /** When true, enforce acceptance-first (TDD red→green) on every worker. */
  acceptanceFirst: boolean;
  /** When true, automatically apply passing workers (with confirmation). Default false. */
  autoApply: boolean;
  /** When true, stop on any detected conflict between workers. */
  stopOnConflict: boolean;
  /** When true, also stop on quality-gate warnings (not just failures). */
  stopOnQualityWarning: boolean;
}

/** Per-prompt delegation assessment (the autonomous-delegation nudge). */
export interface DelegateAssessConfig {
  /** When true, each substantial prompt is assessed and the model is nudged
   *  toward the `delegate` tool for broad/multi-area work. Advisory only. */
  enabled: boolean;
}

export interface DelegateVerifyConfig {
  enabled: boolean;
}

export interface DelegateConfig {
  qualityGate: QualityGateOptions;
  acceptanceFirst: AcceptanceFirstOptions;
  autopilot: DelegateAutopilotConfig;
  assess: DelegateAssessConfig;
  verify?: DelegateVerifyConfig;
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

export const DEFAULT_DELEGATE_AUTOPILOT: DelegateAutopilotConfig = {
  enabled: false,
  maxRounds: 3,
  maxWorkers: 5,
  maxConcurrency: 2,
  acceptanceFirst: true,
  autoApply: false,
  stopOnConflict: true,
  stopOnQualityWarning: false,
};

// Verify-then-force is the default delegation posture: `/delegate plan` produces
// acceptance-first plans (workers must make a production change, tests gate the
// result) unless explicitly disabled via DEEPCODER_DELEGATE_ACCEPTANCE_FIRST=0
// or config. The autopilot path is already acceptance-first by default.
export const DEFAULT_ACCEPTANCE_FIRST: AcceptanceFirstOptions = { enabled: true };

// The per-prompt delegation nudge is ON by default: it is advisory and read-only
// (it only injects a hint; the model still decides), and autonomous delegation is
// the feature this exists to enable. Disable with DEEPCODER_DELEGATE_ASSESS=0.
export const DEFAULT_DELEGATE_ASSESS: DelegateAssessConfig = { enabled: true };

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

// deepcoder is DeepSeek-only. `deepseek` is the default; `openai-compatible` is a
// generic escape hatch (same engine) for a local/proxy/self-hosted DeepSeek
// endpoint set via DEEPCODER_BASE_URL.
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  "openai-compatible": "deepseek-v4-flash",
  // Test/smoke harness only (canned no-op provider; no key, no network).
  faux: "faux",
};

const KNOWN_PROVIDERS = new Set(Object.keys(PROVIDER_DEFAULT_MODELS));

/**
 * Per-provider env-var prefix. Each provider resolves its key/baseUrl/model from
 * its OWN prefix only, so credentials never bleed across providers.
 */
const PROVIDER_ENV_PREFIX: Record<string, string> = {
  deepseek: "DEEPSEEK",
  "openai-compatible": "OPENAI",
};

export type ConfigOverrides = Partial<Omit<Config, "sandbox" | "workspaceIsolation" | "hooks" | "diagnostics" | "skills" | "dependencyHealing" | "delegate" | "format">> & {
  prContext?: PrContext;
  sandbox?: Partial<SandboxConfig>;
  workspaceIsolation?: Partial<WorkspaceIsolationConfig>;
  hooks?: Partial<HooksConfig>;
  diagnostics?: Partial<DiagnosticsConfig>;
  context?: Partial<ContextConfig>;
  skills?: Partial<SkillsConfig>;
  dependencyHealing?: Partial<DependencyHealingConfig>;
  delegate?: { qualityGate?: Partial<QualityGateOptions>; acceptanceFirst?: Partial<AcceptanceFirstOptions>; autopilot?: Partial<DelegateAutopilotConfig>; assess?: Partial<DelegateAssessConfig> };
  format?: FormatConfig | null;
};

/**
 * Turn budget for an interactive session when DEEPCODER_MAX_TURNS is not set.
 * The turn cap exists to stop a runaway loop burning tokens unattended; in an
 * interactive session the human is that guard (and can Ctrl-C), so the floor is
 * generous enough to implement a full plan without aborting mid-flight.
 */
export const INTERACTIVE_MAX_TURNS = 200;

/**
 * Resolve the effective per-task turn cap. An explicit DEEPCODER_MAX_TURNS
 * (envExplicit) is always honored verbatim. Otherwise an interactive session is
 * lifted to at least INTERACTIVE_MAX_TURNS; headless keeps the configured cap.
 */
export function effectiveMaxTurns(opts: { configMaxTurns: number; interactive: boolean; envExplicit: boolean }): number {
  if (opts.envExplicit) return opts.configMaxTurns;
  if (opts.interactive) return Math.max(opts.configMaxTurns, INTERACTIVE_MAX_TURNS);
  return opts.configMaxTurns;
}

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

  // Phase 10S — workspace containment: default < config file < env gate < CLI.
  const containEnv = (process.env.DEEPCODER_CONTAIN ?? "").toLowerCase();
  const containment: ContainmentConfig = {
    ...DEFAULT_CONTAINMENT,
    ...(file.containment ?? {}),
    ...(["1", "true", "yes"].includes(containEnv) ? { enabled: true } : {}),
    ...(["0", "false", "no"].includes(containEnv) ? { enabled: false } : {}),
    ...(overrides.containment ?? {}), // CLI wins
  };

  // Containment defaults ON (fail-closed), but an EXPLICIT opt-out is honored:
  // `--no-contain`, `DEEPCODER_CONTAIN=0`, or a config-file setting all disable it
  // (resolved by precedence above). yolo still forces it back ON below — there the
  // sandbox is the only safety net, so the opt-out must not win. Boot still
  // fail-fails if containment is ON but bwrap is missing (see cli/main.ts), so the
  // default never silently degrades to uncontained.

  // Phase 10T — yolo couples three settings: it auto-approves everything (handled
  // in checkPermission), so it MUST keep the sandbox as the only safety net —
  // force containment ON (overriding --no-contain) and force the UNCONTAINED
  // escape hatches (MCP-execute, PTY shell) OFF so "approve all" can't reach out.
  const effectiveApproval = (overrides.approvalMode as ApprovalMode | undefined) ?? approval;
  const isYolo = effectiveApproval === "yolo";
  if (isYolo) containment.enabled = true;

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

  // Diagnostics: default < config file < env gate (DEEPCODER_DIAGNOSTICS=1).
  const diagEnv = (process.env.DEEPCODER_DIAGNOSTICS ?? "").toLowerCase();
  const diagnostics: DiagnosticsConfig = {
    ...DEFAULT_DIAGNOSTICS,
    ...(file.diagnostics ?? {}),
    ...(["1", "true", "yes"].includes(diagEnv) ? { enabled: true } : {}),
    ...(["0", "false", "no"].includes(diagEnv) ? { enabled: false } : {}),
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

  const overrideAcceptanceFirst = delegateOverride?.acceptanceFirst ?? {};
  const fileAcceptanceFirst = (fileDelegate.acceptanceFirst ?? {}) as Partial<AcceptanceFirstOptions>;
  const afEnabledEnv = process.env.DEEPCODER_DELEGATE_ACCEPTANCE_FIRST;
  const acceptanceFirst: AcceptanceFirstOptions = {
    enabled: overrideAcceptanceFirst.enabled !== undefined
      ? overrideAcceptanceFirst.enabled
      : (afEnabledEnv !== undefined
        ? ["1", "true", "yes"].includes(afEnabledEnv.toLowerCase())
        : (fileAcceptanceFirst.enabled ?? DEFAULT_ACCEPTANCE_FIRST.enabled)),
  };

  // Phase 9P — Delegation Autopilot config: default OFF (opt-in only).
  const overrideAutopilot = delegateOverride?.autopilot ?? {};
  const fileAutopilot = (fileDelegate.autopilot ?? {}) as Partial<DelegateAutopilotConfig>;
  const apEnabledEnv = process.env.DEEPCODER_DELEGATE_AUTOPILOT;
  const apMaxRoundsEnv = process.env.DEEPCODER_DELEGATE_AUTOPILOT_MAX_ROUNDS;
  const apMaxWorkersEnv = process.env.DEEPCODER_DELEGATE_AUTOPILOT_MAX_WORKERS;
  const apMaxConcurrencyEnv = process.env.DEEPCODER_DELEGATE_AUTOPILOT_MAX_CONCURRENCY;
  const autopilot: DelegateAutopilotConfig = {
    enabled: overrideAutopilot.enabled !== undefined
      ? overrideAutopilot.enabled
      : (apEnabledEnv !== undefined
        ? ["1", "true", "yes"].includes(apEnabledEnv.toLowerCase())
        : (fileAutopilot.enabled ?? DEFAULT_DELEGATE_AUTOPILOT.enabled)),
    maxRounds: overrideAutopilot.maxRounds ?? (apMaxRoundsEnv ? numEnv(apMaxRoundsEnv, DEFAULT_DELEGATE_AUTOPILOT.maxRounds) : (fileAutopilot.maxRounds ?? DEFAULT_DELEGATE_AUTOPILOT.maxRounds)),
    maxWorkers: overrideAutopilot.maxWorkers ?? (apMaxWorkersEnv ? numEnv(apMaxWorkersEnv, DEFAULT_DELEGATE_AUTOPILOT.maxWorkers) : (fileAutopilot.maxWorkers ?? DEFAULT_DELEGATE_AUTOPILOT.maxWorkers)),
    maxConcurrency: overrideAutopilot.maxConcurrency ?? (apMaxConcurrencyEnv ? numEnv(apMaxConcurrencyEnv, DEFAULT_DELEGATE_AUTOPILOT.maxConcurrency) : (fileAutopilot.maxConcurrency ?? DEFAULT_DELEGATE_AUTOPILOT.maxConcurrency)),
    acceptanceFirst: overrideAutopilot.acceptanceFirst ?? fileAutopilot.acceptanceFirst ?? DEFAULT_DELEGATE_AUTOPILOT.acceptanceFirst,
    autoApply: overrideAutopilot.autoApply ?? fileAutopilot.autoApply ?? DEFAULT_DELEGATE_AUTOPILOT.autoApply,
    stopOnConflict: overrideAutopilot.stopOnConflict ?? fileAutopilot.stopOnConflict ?? DEFAULT_DELEGATE_AUTOPILOT.stopOnConflict,
    stopOnQualityWarning: overrideAutopilot.stopOnQualityWarning ?? fileAutopilot.stopOnQualityWarning ?? DEFAULT_DELEGATE_AUTOPILOT.stopOnQualityWarning,
  };

  // Per-prompt delegation nudge: default ON; env DEEPCODER_DELEGATE_ASSESS=0/false/no disables.
  const overrideAssess = delegateOverride?.assess ?? {};
  const fileAssess = (fileDelegate.assess ?? {}) as Partial<DelegateAssessConfig>;
  const assessEnabledEnv = process.env.DEEPCODER_DELEGATE_ASSESS;
  const assess: DelegateAssessConfig = {
    enabled: overrideAssess.enabled !== undefined
      ? overrideAssess.enabled
      : (assessEnabledEnv !== undefined
        ? !["0", "false", "no"].includes(assessEnabledEnv.toLowerCase())
        : (fileAssess.enabled ?? DEFAULT_DELEGATE_ASSESS.enabled)),
  };

  const delegate: DelegateConfig = {
    qualityGate,
    acceptanceFirst,
    autopilot,
    assess,
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

  const provider = (overrides.provider ?? (process.env.DEEPCODER_PROVIDER || "deepseek")).toLowerCase();
  // Validate the provider BEFORE requiring a key, so a typo'd provider reports
  // "unknown provider" rather than a misleading "missing API key".
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider "${provider}". Use deepseek | openai-compatible.`);
  }

  // Resolve credentials from the selected provider's OWN prefix (DEEPSEEK_* or
  // OPENAI_*). Explicit DEEPCODER_* always wins; a provider never reads another
  // provider's prefix.
  const prefix = PROVIDER_ENV_PREFIX[provider];
  const providerEnv = (suffix: string): string | undefined =>
    prefix ? process.env[`${prefix}_${suffix}`] : undefined;

  const apiKeyRaw = overrides.apiKey ?? process.env.DEEPCODER_API_KEY ?? providerEnv("API_KEY");
  // The faux smoke-harness provider makes no network calls, so it needs no key.
  const apiKey = provider === "faux" ? (apiKeyRaw ?? "") : req("API key (DEEPCODER_API_KEY)", apiKeyRaw);
  const baseUrl = process.env.DEEPCODER_BASE_URL ?? providerEnv("BASE_URL") ?? "";
  const model =
    process.env.DEEPCODER_MODEL ?? providerEnv("MODEL") ?? PROVIDER_DEFAULT_MODELS[provider] ?? "deepseek-v4-flash";

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

  // Phase 10E web config: webConfigFromEnv starts from defaultWebConfig and applies
  // DEEPCODER_WEB* env vars; overrides (e.g. test) apply on top.
  const web: WebConfig = { ...webConfigFromEnv(process.env), ...(overrides.web ?? {}) };

  // LSP: opt-in (default off). fileConfig provides the block; DEEPCODER_LSP flips
  // enabled. `servers` (per-language command overrides) comes from the file only.
  const lspFile = (file as { lsp?: Partial<LspConfig> }).lsp ?? {};
  const lsp: LspConfig = {
    enabled:
      ["1", "true", "yes"].includes((process.env.DEEPCODER_LSP ?? "").toLowerCase()) ||
      lspFile.enabled === true,
    ...(lspFile.servers ? { servers: lspFile.servers } : {}),
    ...(overrides.lsp ?? {}),
  };

  const format: FormatConfig | null = file.format ?? null;

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature,
    reasoningEffort,
    semanticSearch,
    web,
    lsp,
    format,
    // Planning/reasoning role defaults to DeepSeek's reasoning model (Pro);
    // other roles use `model` (Flash) via the model router.
    reasonerModel: process.env.DEEPCODER_REASONER_MODEL ?? providerEnv("REASONER_MODEL") ?? "deepseek-v4-pro",
    planFirst:
      ["1", "true", "yes"].includes((process.env.DEEPCODER_PLAN_FIRST ?? "").toLowerCase()) ||
      ["1", "true", "yes"].includes((process.env.DEEPCODER_SOLVE_PLAN_FIRST ?? "").toLowerCase()),
    solveCheck: process.env.DEEPCODER_SOLVE_CHECK || undefined,
    solveMaxAttempts: Math.max(1, Math.trunc(numEnv(process.env.DEEPCODER_SOLVE_MAX_ATTEMPTS, 3))),
    solveRepro: process.env.DEEPCODER_SOLVE_REPRO === "auto" ? "auto" : undefined,
    solveReproPath: process.env.DEEPCODER_SOLVE_REPRO_PATH || undefined,
    solveTelemetry: process.env.DEEPCODER_SOLVE_TELEMETRY || undefined,
    subagentModel: process.env.DEEPCODER_SUBAGENT_MODEL,
    maxTurns: numEnv(process.env.DEEPCODER_MAX_TURNS, 40),
    approvalMode: approval,
    // Provider-aware default: DeepSeek ships a 1M context window, so use it by
    // default (deepcoder's default provider). Other providers keep a conservative
    // 120K (their windows are smaller — e.g. GPT-mini 400K, Claude 200K — and a
    // smaller stable context caches better). DEEPCODER_CONTEXT_BUDGET_TOKENS /
    // DEEPCODER_COMPACT_AT still override either default.
    contextBudgetTokens: numEnv(
      process.env.DEEPCODER_CONTEXT_BUDGET_TOKENS,
      provider === "deepseek" ? 1_000_000 : 120_000,
    ),
    // Trim at 0.8 of the budget for every provider. For DeepSeek's 1M window
    // that still leaves ~800K working tokens, but caps how large the re-sent
    // context grows per turn (the dominant cost), complementing the agent
    // loop's read-budget nudge. DEEPCODER_COMPACT_AT overrides.
    compactAt: numEnv(process.env.DEEPCODER_COMPACT_AT, 0.8),
    checkpoints: (["off", "manual", "auto"].includes(process.env.DEEPCODER_CHECKPOINTS ?? "")
      ? (process.env.DEEPCODER_CHECKPOINTS as CheckpointMode)
      : "off"),
    workspaceRoot,
    mcpServers: file.mcpServers ?? {},
    checks: file.checks ?? {},
    commands: file.commands ?? {},
    // Default-off / fail-closed: execute-mode MCP tools are denied unless
    // explicitly opted in. Enabling only lifts the blanket deny — each call
    // still flows through the permission policy (classifier + approval mode).
    // 10T: yolo forces these uncontained escape hatches OFF regardless of env.
    mcpExecuteEnabled: isYolo ? false :
      (process.env.DEEPCODER_MCP_EXECUTE === "1" ||
       process.env.DEEPCODER_MCP_EXECUTE === "true"),
    interactiveShell: isYolo ? false :
      (process.env.DEEPCODER_INTERACTIVE_SHELL === "1" ||
       process.env.DEEPCODER_INTERACTIVE_SHELL === "true"), // Phase 10G: default-off
    ...rest,
    // A CLI partial (e.g. {mode}) layers on top of the file/env-resolved sandbox
    // rather than replacing it wholesale. 10S: when containment is on it WINS —
    // the effective sandbox becomes fail-closed workspace-only (overrides --sandbox).
    sandbox: containment.enabled
      ? applyContainment({ ...sandbox, ...(sandboxOverride ?? {}) })
      : { ...sandbox, ...(sandboxOverride ?? {}) },
    containment,
    workspaceIsolation: { ...workspaceIsolation, ...(wsIsoOverride ?? {}) },
    hooks: { ...hooks, ...(overrides.hooks ?? {}) },
    diagnostics: { ...diagnostics, ...(overrides.diagnostics ?? {}) },
    context: { ...context, ...(overrides.context ?? {}) },
    skills: { ...skills, ...(overrides.skills ?? {}) },
    dependencyHealing: { ...dependencyHealing, ...(overrides.dependencyHealing ?? {}) },
    delegate,
    testTargeting,
    keybinds: resolveKeybinds(file.keybinds),
    models: file.models,
    statusline: file.statusline,
    telemetry: {
      statusline: (process.env.DEEPCODER_STATUSLINE ?? "").toLowerCase() === "off" ? false : (file.telemetry?.statusline ?? true),
      costs: file.telemetry?.costs ?? true,
      pricing: file.telemetry?.pricing,
    },
  };
}
