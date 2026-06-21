/**
 * Phase 7I — post-write diagnostic runner.
 *
 * After a mutating tool succeeds, this module matches changed files against
 * configured diagnostic rules, classifies each command, and runs the matched
 * rules through a bounded/redacted process. Results are persisted to
 * `.deepcoder/diagnostics/<run-id>.log`.
 *
 * Safety: DEFAULT DISABLED. Command is CONFIG-defined (never model-defined),
 * classifier-gated, sandboxed, redacted, and capped. No auto-fix in v1.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { matchRules } from "./matcher.js";
import type { DiagnosticRule, DiagnosticsConfig, DiagnosticRun } from "./types.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { redactSecrets } from "../workspace/redact.js";
import type { BoundedProcessResult } from "../process/runBoundedProcess.js";
import type { SandboxConfig } from "../sandbox/types.js";

/** Maximum bytes of output to capture per diagnostic run. */
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;

/** Maximum bytes for the summary field (after redaction + capping). */
const SUMMARY_MAX_BYTES = 4_096;

/** Maximum log file bytes (before redaction). */
const LOG_MAX_BYTES = 65_536;

/**
 * Injectable spawn function matching the signature of runBoundedProcess.
 * Defaults to the real implementation; tests inject a mock.
 */
export type SpawnFn = (input: {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  maxCaptureBytes: number;
  shell?: boolean;
  onData?: (chunk: string) => void;
}) => Promise<BoundedProcessResult>;

export interface RunPostWriteDiagnosticsInput {
  workspaceRoot: string;
  affectedPaths: string[];
  config: DiagnosticsConfig;
  sandbox?: SandboxConfig;
  signal: AbortSignal;
  onData?: (chunk: string) => void;
  /**
   * Injectable spawn function. Defaults to the real runBoundedProcess.
   * Tests inject a mock to avoid spawning real processes.
   */
  spawn?: SpawnFn;
}

/**
 * Run post-write diagnostics for the given affected paths.
 *
 * Returns an array of DiagnosticRun records, one per matched rule that was
 * actually executed (or skipped due to classifier denial). When diagnostics
 * are disabled, returns [] immediately — no spawn, no I/O.
 */
export async function runPostWriteDiagnostics(
  input: RunPostWriteDiagnosticsInput,
): Promise<DiagnosticRun[]> {
  const { workspaceRoot, affectedPaths, config, sandbox, signal, onData } = input;
  const spawn = input.spawn ?? defaultSpawn;

  // HARD RULE: disabled → no-op, byte-identical to today.
  if (!config.enabled) return [];

  // Match rules against affected paths.
  const matches = matchRules(affectedPaths, config.rules);

  // Cap at maxPerTurn.
  const capped = matches.slice(0, config.maxPerTurn);

  const runs: DiagnosticRun[] = [];

  for (const match of capped) {
    const rule = match.rule;
    const files = match.files;

    // Compose the command: replace `{files}` with shell-quoted paths.
    const command = composeCommand(rule.command, files);

    // Classifier gate: denied commands are skipped, not run.
    if (classifyCommand(command) === "deny") {
      runs.push(buildSkippedRun(rule, files, command, "denied by command classifier"));
      continue;
    }

    // Run the diagnostic command.
    const startedAt = new Date().toISOString();
    const timeoutMs = rule.timeoutMs ?? config.timeoutMs;
    const maxOutputBytes = rule.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // Apply sandbox wrapping if configured.
    let toRun = command;
    if (sandbox) {
      const { wrapCommand } = await import("../sandbox/index.js");
      toRun = wrapCommand({ command, workspaceRoot }, sandbox).command;
    }

    const result = await spawn({
      file: toRun,
      args: [],
      shell: true,
      cwd: workspaceRoot,
      env: process.env,
      signal,
      timeoutMs,
      maxCaptureBytes: maxOutputBytes,
      onData,
    });

    const finishedAt = new Date().toISOString();

    // Build the summary (redacted + capped).
    const summary = buildSummary(result, rule.name);

    // Persist the (redacted) log — redact defensively before writing.
    const logPath = await persistLog(workspaceRoot, rule.name, redactSecrets(result.captured));

    runs.push({
      name: rule.name,
      command: redactSecrets(command),
      affectedPaths: files,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      logPath,
      summary,
    });
  }

  return runs;
}

/**
 * Compose the shell command from a rule template.
 *
 * `{files}` is replaced with shell-quoted, workspace-relative affected file
 * paths. If the template contains no `{files}`, the command is used as-is.
 * The quoting is conservative: each path is wrapped in single quotes with
 * embedded single quotes escaped per POSIX shell rules.
 */
function composeCommand(template: string, files: string[]): string {
  if (!template.includes("{files}")) return template;
  const quoted = files.map(shellQuote).join(" ");
  return template.replace(/\{files\}/g, quoted);
}

/**
 * POSIX shell single-quote a path.
 * A single quote inside the path is escaped as: `'\\''` (end quote, literal
 * single-quote, reopen quote).
 */
function shellQuote(p: string): string {
  const s = p.replace(/\\/g, "/");
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a bounded summary from the process result.
 */
function buildSummary(result: BoundedProcessResult, ruleName: string): string {
  const lines: string[] = [];

  if (result.exitCode === 0 && !result.timedOut) {
    lines.push(`Diagnostic "${ruleName}" passed (exit 0).`);
  } else if (result.timedOut) {
    lines.push(`Diagnostic "${ruleName}" timed out.`);
  } else if (result.exitCode !== null) {
    lines.push(`Diagnostic "${ruleName}" failed (exit ${result.exitCode}):`);
  } else {
    lines.push(`Diagnostic "${ruleName}" failed (no exit code).`);
  }

  // Redact defensively (never assume the captured output is already clean — the
  // injectable spawn seam may not be the real bounded/redacted process).
  const captured = redactSecrets(result.captured).trim();
  if (captured) {
    lines.push(captured);
  }

  if (result.truncated) {
    lines.push("(output truncated)");
  }

  let summary = lines.join("\n");

  // Cap the summary.
  if (Buffer.byteLength(summary, "utf8") > SUMMARY_MAX_BYTES) {
    summary = Buffer.from(summary, "utf8")
      .subarray(0, SUMMARY_MAX_BYTES)
      .toString("utf8")
      .replace(/\n[^\n]*$/, ""); // don't break mid-line
    summary += "\n(output truncated)";
  }

  return summary;
}

/**
 * Build a DiagnosticRun for a skipped/refused rule (e.g. classifier denied).
 */
function buildSkippedRun(
  rule: DiagnosticRule,
  files: string[],
  command: string,
  reason: string,
): DiagnosticRun {
  const now = new Date().toISOString();
  return {
    name: rule.name,
    command: redactSecrets(command),
    affectedPaths: files,
    startedAt: now,
    finishedAt: now,
    exitCode: null,
    timedOut: false,
    truncated: false,
    summary: `Diagnostic "${rule.name}" skipped: ${reason}.`,
  };
}

/**
 * Persist the (redacted) diagnostic output to `.deepcoder/diagnostics/<run-id>.log`.
 * Returns the relative log path, or undefined if persistence fails.
 */
async function persistLog(
  workspaceRoot: string,
  ruleName: string,
  captured: string,
): Promise<string | undefined> {
  try {
    const dir = path.join(workspaceRoot, ".deepcoder", "diagnostics");
    await fs.mkdir(dir, { recursive: true });

    // Generate a short unique run ID.
    const id = `${ruleName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logPath = path.join(".deepcoder", "diagnostics", `${id}.log`);

    // Redact and cap the log content.
    const redacted = redactSecrets(captured);
    const capped = Buffer.from(redacted, "utf8")
      .subarray(0, LOG_MAX_BYTES)
      .toString("utf8");

    await fs.writeFile(path.join(workspaceRoot, logPath), capped, "utf8");
    return logPath;
  } catch {
    // Persistence failure must not break the diagnostic run.
    return undefined;
  }
}

/**
 * Default spawn function — delegates to the real runBoundedProcess.
 */
async function defaultSpawn(
  input: {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
    maxCaptureBytes: number;
    shell?: boolean;
    onData?: (chunk: string) => void;
  },
): Promise<BoundedProcessResult> {
  const { runBoundedProcess } = await import("../process/runBoundedProcess.js");
  return runBoundedProcess(input);
}
