import { spawn } from "node:child_process";
import path from "node:path";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { redactSecrets } from "../workspace/redact.js";
import {
  saveCheckRun,
  newCheckRunId,
  CHECK_LOG_MAX_BYTES,
  type CheckRun,
} from "../session/checkRuns.js";
import type { CheckConfig } from "../config/fileConfig.js";

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
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a single named, user-configured check. Classifier-gated (a `deny` command
 * is refused even if configured), bounded, redacted, and persisted to a
 * quarantined run record. Never throws on a non-zero exit — only on internal
 * setup failure or a classifier refusal.
 */
export async function runCheck(name: string, check: CheckConfig, opts: RunCheckOptions): Promise<CheckRun> {
  if (classifyCommand(check.command) === "deny") {
    throw new CheckRefusedError(`Check "${name}" command is blocked by the permission policy: ${check.command}`);
  }

  const id = newCheckRunId();
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let captured = "";
  let truncated = false;
  const append = (buf: Buffer): void => {
    // Best-effort redaction for the live stream too (the persisted log is
    // redacted wholesale, which also catches secrets split across chunks).
    opts.onData?.(redactSecrets(buf.toString("utf8")));
    if (captured.length < CHECK_LOG_MAX_BYTES) {
      captured += buf.toString("utf8");
      if (captured.length >= CHECK_LOG_MAX_BYTES) {
        captured = captured.slice(0, CHECK_LOG_MAX_BYTES);
        truncated = true;
      }
    }
  };

  const result = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    // Own process group so a timeout/abort can take down the whole shell tree.
    const child = spawn(check.command, {
      cwd: opts.workspaceRoot,
      shell: true,
      detached: true,
    });

    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => killGroup();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, signal, timedOut });
    };
    child.on("error", (err) => {
      append(Buffer.from(`\n[spawn error] ${err.message}\n`));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

  const run: CheckRun = {
    id,
    name,
    command: check.command,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    exitCode: result.exitCode,
    signal: result.signal ?? undefined,
    timedOut: result.timedOut,
    truncated,
    logPath: path.join(".deepcoder", "runs", `${id}.log`),
  };

  // Redact before anything is persisted.
  await saveCheckRun(opts.workspaceRoot, run, redactSecrets(captured));
  return run;
}
