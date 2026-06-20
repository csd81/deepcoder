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
  const toRun = opts.sandbox
    ? wrapCommand({ command: check.command, workspaceRoot: opts.workspaceRoot }, opts.sandbox).command
    : check.command;

  // A configured check is a shell command string (it may use pipes/redirects),
  // so it runs through a shell — unlike the worker runner, which spawns argv.
  const result = await runBoundedProcess({
    file: toRun,
    args: [],
    shell: true,
    cwd: opts.workspaceRoot,
    env: process.env,
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
  return run;
}
