import "dotenv/config";

export type ApprovalMode = "ask" | "auto" | "readonly";

export interface Config {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasonerModel?: string;
  maxTurns: number;
  approvalMode: ApprovalMode;
  /** Absolute path the agent is allowed to operate within. */
  workspaceRoot: string;
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
  return {
    provider: "deepseek",
    apiKey: req("DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY),
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    reasonerModel: process.env.DEEPSEEK_REASONER_MODEL,
    maxTurns: Number(process.env.DEEPCODER_MAX_TURNS || 20),
    approvalMode: approval,
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}
