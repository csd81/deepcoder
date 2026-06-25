export interface SubagentProfile {
  name: string;
  purpose: string;
  /** Native tool names the subagent may use (read-only). */
  allowedTools: string[];
  maxTurns: number;
  contextBudgetTokens: number;
  /** Profile-specific output instructions appended to the boundary prompt. */
  outputGuidance?: string;
  /** Phase 10F: model role for router-based model resolution. */
  role?: import("../models/types.js").ModelRole;
  /** Phase 10E — this profile may use the web tools when web is enabled in config. */
  webOptIn?: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";

/** Verdict from the adversarial finding-verifier (see src/delegate/verifyFindings.ts). */
export type FindingVerdict = "confirmed" | "refuted" | "unverifiable";

export interface SubagentFinding {
  severity: Severity;
  file?: string;
  line?: number;
  claim: string;
  evidence: string;
  /** Set by auto-verification: whether an independent verifier confirmed the claim. */
  verdict?: FindingVerdict;
  /** The verifier's evidence/reason for its verdict. */
  verifyEvidence?: string;
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
  /** Sidechain run id, when the full transcript was persisted (audit metadata). */
  sidechainRunId?: string;
  /** Model-safe aggregate of the persisted sidechain transcript. */
  sidechainStats?: { entries: number; byRole: Record<string, number> };
}

/**
 * A persisted record of a subagent run. Stored in SEPARATE session metadata for
 * audit/durability — deliberately NOT added to the model-visible message history,
 * so untrusted subagent output can never poison the parent's future context.
 */
export interface SubagentRunRecord {
  createdAt: string;
  result: SubagentResult;
  trace: SubagentTrace;
}

export interface RunSubagentOptions {
  workspaceRoot: string;
  /** Parent provider — the subagent reuses it (read-only). */
  provider: import("../providers/types.js").ModelProvider;
  parentModel: string;
  subagentModel?: string;
  /** Phase 10F: model router for role-based model resolution. */
  modelRouter?: import("../models/router.js").ModelRouter;
  /** Phase 10F: provider pool to get a provider for a resolved route. */
  providerPool?: import("../models/providerPool.js").ProviderPool;
  contextBudgetTokens: number;
  compactAt: number;
  signal: AbortSignal;
  /** Phase 10E — web tool instances to offer opt-in profiles when web is enabled. */
  webTools?: import("../tools/types.js").Tool[];
  /**
   * Persist the full subagent transcript to a sidechain JSONL (audit trail,
   * outside the parent's model-visible context). Explicit override; defaults to
   * the DEEPCODER_SUBAGENT_SIDECHAIN env (off unless 1/true/yes/on).
   */
  sidechain?: boolean;
}
