import "dotenv/config";
import { loadFileConfig, type McpServerConfig } from "./fileConfig.js";

export type ApprovalMode = "ask" | "auto" | "readonly";

export interface Config {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasonerModel?: string;
  maxTurns: number;
  approvalMode: ApprovalMode;
  /** Approximate token budget before history compaction kicks in. */
  contextBudgetTokens: number;
  /** Fraction of the budget at which compaction triggers. */
  compactAt: number;
  /** Absolute path the agent is allowed to operate within. */
  workspaceRoot: string;
  /** MCP servers from .deepcoder/config.json (empty if none configured). */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * Whether execute-kind MCP tools may run. Off in Phase 4A — execute-mode MCP
   * tools are discovered but denied until a later phase enables them.
   */
  mcpExecuteEnabled: boolean;
}

function req(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required config "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const approval = (process.env.DEEPCODER_APPROVAL_MODE as ApprovalMode) || "ask";
  const workspaceRoot = overrides.workspaceRoot ?? process.cwd();
  const file = loadFileConfig(workspaceRoot);
  return {
    provider: "deepseek",
    apiKey: req("DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY),
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    reasonerModel: process.env.DEEPSEEK_REASONER_MODEL,
    maxTurns: Number(process.env.DEEPCODER_MAX_TURNS || 20),
    approvalMode: approval,
    contextBudgetTokens: Number(process.env.DEEPCODER_CONTEXT_BUDGET_TOKENS || 64000),
    compactAt: Number(process.env.DEEPCODER_COMPACT_AT || 0.8),
    workspaceRoot,
    mcpServers: file.mcpServers ?? {},
    mcpExecuteEnabled: false, // Phase 4A: execute-mode MCP tools are denied
    ...overrides,
  };
}
