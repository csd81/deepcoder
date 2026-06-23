import path from "node:path";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { redactSecrets } from "../workspace/redact.js";
import { runBoundedProcess } from "../process/runBoundedProcess.js";
import {
  saveCheckRun,
  newCheckRunId,
  CHECK_LOG_MAX_BYTES,
  type CheckRun,
} from "../session/checkRuns.js";
import type { CheckConfig } from "../config/fileConfig.js";
import { wrapCommand } from "../sandbox/index.js";
import type { SandboxConfig } from "../sandbox/types.js";
import type { DependencyHealingConfig } from "../config/config.js";
import { maybeHealDependencies } from "../dependencies/healer.js";
import { cleanEnv } from "../process/env.js";

/** Thrown when a configured check command is denied by the command classifier. */
export class CheckRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckRefusedError";
  }
}

export interface RunCheckOptions {
  workspaceRoot: string;
  signal: AbortSignal;
  /** Live output sink (e.g. terminal). Receives raw chunks as they arrive. */
  onData?(chunk: string): void;
  /** When set, the check command is isolated through this sandbox policy. */
  sandbox?: SandboxConfig;
  /**
   * Phase 7G — when present AND `enabled`, a dependency-shaped failure triggers
   * exactly one allowlisted repair + a single retry. Absent/disabled → runCheck
   * behaves exactly as before (a true no-op).
   */
  dependencyHealing?: DependencyHealingConfig;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000; // hard ceiling regardless of config

/**
 * Run a single named, user-configured check. Classifier-gated (a `deny` command
 * is refused even if configured), bounded, redacted, and persisted to a
 * quarantined run record. Never throws on a non-zero exit — only on internal
 * setup failure or a classifier refusal.
 *
 * The bounded/redacted/hard-killable spawn itself lives in `runBoundedProcess`,
 * shared with the delegated worker runner so the security semantics stay
 * byte-identical across call sites.
 */
export async function runCheck(name: string, check: CheckConfig, opts: RunCheckOptions): Promise<CheckRun> {
  const { run, captured } = await runCheckOnce(name, check, opts);

  // Phase 7G: dependency self-healing. Off by default → return immediately
  // (identical to the pre-7G behavior). Healing is NEVER applied to the retry.
  const heal = opts.dependencyHealing;
  if (!heal?.enabled || run.exitCode === 0 || run.timedOut) return run;

  const record = await maybeHealDependencies(captured, {
    workspaceRoot: opts.workspaceRoot,
    signal: opts.signal,
    sandbox: opts.sandbox,
    config: heal,
    checkRunId: run.id,
    onData: opts.onData,
  });
  run.dependencyHealing = record;

  // Retry the original check exactly once, only if the repair ran and succeeded.
  if (record.attempted && record.exitCode === 0) {
    const retry = await runCheckOnce(name, check, { ...opts, dependencyHealing: undefined });
    retry.run.dependencyHealing = { ...record, retriedCheckRunId: retry.run.id };
    await saveCheckRun(opts.workspaceRoot, retry.run, retry.captured);
    return retry.run;
  }

  // No repair (or repair failed): persist the healing record onto the original.
  await saveCheckRun(opts.workspaceRoot, run, captured);
  return run;
}

/**
 * Run a single named check exactly once (no healing). Classifier-gated, bounded,
 * redacted, persisted. Returns the run plus its captured output (so the healing
 * wrapper can inspect the failure without re-reading the log).
 */
async function runCheckOnce(
  name: string,
  check: CheckConfig,
  opts: RunCheckOptions,
): Promise<{ run: CheckRun; captured: string }> {
  if (classifyCommand(check.command) === "deny") {
    throw new CheckRefusedError(`Check "${name}" command is blocked by the permission policy: ${check.command}`);
  }

  const id = newCheckRunId();
  const startedAt = new Date().toISOString();
  const start = Date.now();
  // Clamp the timeout so a misconfigured check can't run unbounded.
  const timeoutMs = Math.min(check.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // Isolate the check command when a sandbox policy is supplied (the original
  // command is still what gets logged below — the wrapper carries no secrets).
  // 10S: under containment, wrapCommand throws if bubblewrap is missing.
  let toRun: string;
  try {
    toRun = opts.sandbox
      ? wrapCommand({ command: check.command, workspaceRoot: opts.workspaceRoot }, opts.sandbox).command
      : check.command;
  } catch (e) {
    throw new Error(`Workspace containment requires bubblewrap; install it or drop --contain. (${(e as Error).message})`);
  }

  // A configured check is a shell command string (it may use pipes/redirects),
  // so it runs through a shell — unlike the worker runner, which spawns argv.
  const result = await runBoundedProcess({
    file: toRun,
    args: [],
    shell: true,
    cwd: opts.workspaceRoot,
    env: cleanEnv(),
    signal: opts.signal,
    timeoutMs,
    maxCaptureBytes: CHECK_LOG_MAX_BYTES,
    onData: opts.onData,
  });

  const run: CheckRun = {
    id,
    name,
    command: redactSecrets(check.command), // a configured command may embed a token
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    exitCode: result.exitCode,
    signal: result.signal ?? undefined,
    timedOut: result.timedOut,
    truncated: result.truncated,
    logPath: path.join(".deepcoder", "runs", `${id}.log`),
  };

  // `result.captured` is already redacted and byte-capped by runBoundedProcess.
  await saveCheckRun(opts.workspaceRoot, run, result.captured);
  return { run, captured: result.captured };
}
