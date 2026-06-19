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

  let captured = "";
  let truncated = false;
  // Redact the LIVE stream on line boundaries so a secret split across chunks
  // isn't emitted un-redacted (the persisted log is redacted wholesale too).
  let linePending = "";
  const emit = (chunk: string) => {
    linePending += chunk;
    const nl = linePending.lastIndexOf("\n");
    if (nl !== -1) {
      opts.onData?.(redactSecrets(linePending.slice(0, nl + 1)));
      linePending = linePending.slice(nl + 1);
    }
  };
  const flushPending = () => {
    if (linePending) {
      opts.onData?.(redactSecrets(linePending));
      linePending = "";
    }
  };
  const append = (buf: Buffer): void => {
    const s = buf.toString("utf8");
    emit(s);
    if (captured.length < CHECK_LOG_MAX_BYTES) {
      captured += s;
      if (captured.length >= CHECK_LOG_MAX_BYTES) {
        captured = captured.slice(0, CHECK_LOG_MAX_BYTES);
        truncated = true;
      }
    }
  };

  const result = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    // Never start the process if we were already aborted.
    if (opts.signal.aborted) {
      resolve({ exitCode: null, signal: "SIGABRT", timedOut: false });
      return;
    }
    // Isolate the check command when a sandbox policy is supplied (the original
    // command is still what gets logged below — the wrapper carries no secrets).
    const toRun = opts.sandbox
      ? wrapCommand({ command: check.command, workspaceRoot: opts.workspaceRoot }, opts.sandbox).command
      : check.command;
    // Own process group so a timeout/abort can take down the whole shell tree.
    const child = spawn(toRun, {
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
      flushPending(); // emit any trailing partial line (redacted)
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
    command: redactSecrets(check.command), // a configured command may embed a token
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
