/**
 * Phase 10C — status snapshot.
 *
 * A cheap, never-throws snapshot of the current session state for rendering
 * in the status line or emitting as a telemetry event. All fields are
 * REDACTED — no API keys, paths with credentials, or other secrets.
 */

import type { TokenUsage } from "../providers/types.js";
import type { CostEstimate } from "../providers/pricing.js";
import { EMPTY_USAGE } from "../providers/usage.js";
import { redactSecrets } from "../workspace/redact.js";

export interface StatusSnapshot {
  provider: string;
  model: string;
  mode: string;
  sandbox: string;
  sandboxNetwork: "on" | "off" | "unknown";
  workspaceIsolation: string;
  git?: { branch?: string; dirtyFiles?: number; ahead?: number; behind?: number };
  usage: TokenUsage;
  cost?: CostEstimate;
  contextPercent?: number;
  activeCheck?: string;
  activeSolveAttempt?: { index: number; max: number };
  mcpWarnings: number;
  activeSkills: number;
  warnings: string[];
}

export interface StatusSnapshotInput {
  provider: string;
  model: string;
  mode: string;
  sandbox: string;
  sandboxNetwork: "on" | "off" | "unknown";
  workspaceIsolation: string;
  usage: TokenUsage;
  cost?: CostEstimate;
  contextPercent?: number;
  activeCheck?: string;
  activeSolveAttempt?: { index: number; max: number };
  mcpWarnings: number;
  activeSkills: number;
  warnings: string[];
  /**
   * Optional git status lookup. When provided, it is called to populate the
   * `git` field. If it throws, git is silently omitted (never throws).
   */
  gitLookup?: () => Promise<{ branch?: string; dirtyFiles?: number; ahead?: number; behind?: number } | undefined>;
}

/**
 * Build a StatusSnapshot from input data.
 *
 * CHEAP — does no I/O except the optional gitLookup (which is wrapped in a
 * try/catch so a failure never propagates).
 *
 * REDACTED — all warning text is run through redactSecrets.
 */
export async function buildStatusSnapshot(input: StatusSnapshotInput): Promise<StatusSnapshot> {
  const snapshot: StatusSnapshot = {
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    sandbox: input.sandbox,
    sandboxNetwork: input.sandboxNetwork,
    workspaceIsolation: input.workspaceIsolation,
    usage: input.usage ?? { ...EMPTY_USAGE },
    cost: input.cost,
    contextPercent: input.contextPercent,
    activeCheck: input.activeCheck,
    activeSolveAttempt: input.activeSolveAttempt,
    mcpWarnings: input.mcpWarnings,
    activeSkills: input.activeSkills,
    warnings: input.warnings.map((w) => redactSecrets(w)),
  };

  // Optional git lookup — never throws
  if (input.gitLookup) {
    try {
      const gitInfo = await input.gitLookup();
      if (gitInfo) {
        snapshot.git = gitInfo;
      }
    } catch {
      // Git failure is silently ignored
    }
  }

  return snapshot;
}
