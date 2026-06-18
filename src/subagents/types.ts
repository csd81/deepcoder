export interface SubagentProfile {
  name: string;
  purpose: string;
  /** Native tool names the subagent may use (read-only). */
  allowedTools: string[];
  maxTurns: number;
  contextBudgetTokens: number;
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface SubagentFinding {
  severity: Severity;
  file?: string;
  line?: number;
  claim: string;
  evidence: string;
}

/** Structured, NON-authoritative subagent output. The parent may quote it but never acts on it. */
export interface SubagentResult {
  profile: string;
  task: string;
  summary: string;
  findings: SubagentFinding[];
  suggestedNextSteps: string[];
  errors: string[];
}

/** Auditable execution trace recorded alongside the result. */
export interface SubagentTrace {
  toolsCalled: string[];
  turns: number;
  model: string;
}

export interface RunSubagentOptions {
  workspaceRoot: string;
  /** Parent provider — the subagent reuses it (read-only). */
  provider: import("../providers/types.js").ModelProvider;
  parentModel: string;
  subagentModel?: string;
  contextBudgetTokens: number;
  compactAt: number;
  signal: AbortSignal;
}
