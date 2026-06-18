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
}

export interface SolveOptions {
  /** The task / issue the agent must resolve. */
  task: string;
  /** Name of a user-configured check to verify with (never model-chosen). */
  checkName: string;
  /** Maximum edit→verify attempts before giving up. */
  maxAttempts: number;
}

export interface SolveResult {
  solved: boolean;
  attempts: SolveAttempt[];
  /** Set when the loop never ran (unknown/denied check, missing task). */
  refusal?: string;
  /** The last check run id (most recent attempt that ran a check). */
  lastRunId?: string;
}
