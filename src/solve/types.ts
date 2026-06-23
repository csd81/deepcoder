/** One attempt of the closed-loop solver: the agent edits, then a check runs. */
export interface SolveAttempt {
  /** 1-based attempt number. */
  index: number;
  /** The quarantined CheckRun id for this attempt (absent if no check ran). */
  checkRunId?: string;
  /** True iff the check exited 0 and did not time out. */
  checkPassed: boolean;
  /** True iff the check was killed by its timeout. */
  checkTimedOut: boolean;
  /** Bounded, redacted failure summary fed back on failure (absent on pass). */
  failureSummary?: string;
  /** Hash of the working-tree patch verified this attempt (detects repeats). */
  patchHash?: string;
  /** Size of that patch in bytes (0 == empty/no edit this attempt). */
  patchBytes?: number;
}

export interface SolveOptions {
  /** The task / issue the agent must resolve. */
  task: string;
  /**
   * Name of a user-configured check to verify with (never model-chosen).
   * Optional only when `repro: "auto"` supplies a generated oracle instead.
   */
  checkName?: string;
  /** Maximum edit→verify attempts before giving up. */
  maxAttempts: number;
  /**
   * Phase 5C — repro-test generation. "auto" lets the solver write its own
   * failing test (the in-loop oracle when no check is configured, or an extra
   * signal/regression artifact alongside a configured check). Default "off".
   */
  repro?: "auto" | "off";
  /** Workspace-relative path for the generated repro test (default: a scratch path). */
  reproPath?: string;
  /**
   * Opt-in (`--plan`): before the fix loop, run the read-only architect flow
   * (explorer → planner), persist the plan under plans/, and inject the rendered
   * plan as advisory context for the agent to follow. Default off.
   */
  plan?: boolean;
}

export interface SolveResult {
  solved: boolean;
  attempts: SolveAttempt[];
  /** Set when the loop never ran (unknown/denied check, missing task). */
  refusal?: string;
  /** The last check run id (most recent attempt that ran a check). */
  lastRunId?: string;
  /** Phase 5C — repro-test generation outcome (absent when repro was off). */
  repro?: ReproResult;
  /** Phase 8D — preflight context gathering was performed before attempt 1. */
  preflightPerformed?: boolean;
  /** Number of explorer tool calls during preflight (0 if preflight was off). */
  preflightExplorerTurns?: number;
  /** Number of files cited in the preflight brief (0 if preflight was off). */
  preflightFilesCited?: number;
  /** Bytes of advisory brief injected by preflight (0 if none/empty). */
  preflightContextBytes?: number;
}

/** Outcome of the Phase 5C repro-test generation phase. */
export interface ReproResult {
  /** A repro file was produced by the constrained generation turn. */
  generated: boolean;
  /** The repro went red on the buggy tree (proved it captures the bug). */
  valid: boolean;
  /** The validated repro was the success oracle (no configured check existed). */
  usedAsOracle: boolean;
  /** The repro tripped the non-tautology guard (shallow/constant-truth test). */
  tautological: boolean;
  /** The repro was kept as a regression test (valid + non-scratch path). */
  kept: boolean;
  /** Workspace-relative path of the repro (present once generation was attempted). */
  path?: string;
  /** Why the repro was rejected/invalid, when applicable. */
  reason?: string;
}
