/**
 * Phase 7I — post-write diagnostic interceptor types.
 *
 * A diagnostic rule matches changed files by glob and runs a configured command
 * to surface syntax/type/lint errors immediately after a write.
 */

export interface DiagnosticRule {
  /** Human-readable name (e.g. "ts", "python"). */
  name: string;
  /** Glob patterns to match workspace-relative affected paths. */
  match: string[];
  /** Shell command to run. May contain `{files}` placeholder. */
  command: string;
  /** Per-rule timeout override (ms). Falls back to config-level timeout. */
  timeoutMs?: number;
  /** Debounce window (ms) — not yet implemented in v1. */
  debounceMs?: number;
  /** Max output bytes for this rule (falls back to config-level cap). */
  maxOutputBytes?: number;
}

export interface DiagnosticsConfig {
  /** Master switch — when false, no diagnostics run and the loop is unchanged. */
  enabled: boolean;
  /** v1 only: "advisory". Future: "blocking". */
  mode: "advisory";
  /** Max diagnostic rules to run per turn (prevents thundering herd). */
  maxPerTurn: number;
  /** Default timeout per diagnostic command (ms). */
  timeoutMs: number;
  /** Diagnostic rules to match against changed files. */
  rules: DiagnosticRule[];
}

export interface DiagnosticRun {
  /** Rule name that produced this run. */
  name: string;
  /** The command that was executed (redacted). */
  command: string;
  /** Workspace-relative paths that triggered this diagnostic. */
  affectedPaths: string[];
  /** ISO timestamp when the diagnostic started. */
  startedAt: string;
  /** ISO timestamp when the diagnostic finished. */
  finishedAt: string;
  /** Exit code (null if timed out or spawn failed). */
  exitCode: number | null;
  /** True if the process was killed due to timeout. */
  timedOut: boolean;
  /** True if the captured output was truncated. */
  truncated: boolean;
  /** Path to the persisted (redacted) log, relative to workspace root. */
  logPath?: string;
  /** Bounded, redacted output summary. */
  summary: string;
}

export const DEFAULT_DIAGNOSTICS: DiagnosticsConfig = {
  enabled: false,
  mode: "advisory",
  maxPerTurn: 2,
  timeoutMs: 120_000,
  rules: [],
};
