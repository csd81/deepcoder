import { spawn } from "node:child_process";
import { redactSecrets } from "../workspace/redact.js";

/**
 * Bounded, redacted, hard-killable child-process execution — the shared engine
 * behind both configured-check execution (`runCheck`) and delegated worker runs
 * (`workerRunner`). Centralising it keeps the security semantics — own process
 * group, `SIGKILL` on timeout/abort, byte-capped capture, line-boundary
 * redaction of the live stream, never-throw-on-nonzero — byte-identical across
 * call sites so they cannot drift.
 *
 * The returned `captured` is already redacted and capped, so it is always safe
 * to log or persist. `onData` receives the same redaction applied on line
 * boundaries (so a secret split across chunks is not emitted un-redacted).
 */
export interface BoundedProcessInput {
  /** Executable to run (or, with `shell:true`, the full command string). */
  file: string;
  /** Argument vector. Secrets never belong here — pass them via `env`. */
  args: string[];
  cwd: string;
  /** The child env. Callers build this explicitly; never default to process.env. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Wall-clock ceiling; the caller is responsible for clamping. */
  timeoutMs: number;
  /** Hard cap on retained output bytes. */
  maxCaptureBytes: number;
  /**
   * Run through a shell. Defaults to `false` (no interpolation — argv is
   * literal). `runCheck` opts in to run a configured command string.
   */
  shell?: boolean;
  /** Live output sink; receives redacted chunks on line boundaries. */
  onData?(chunk: string): void;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  /** Redacted, byte-capped output. Safe to log or persist as-is. */
  captured: string;
}

const LINE_PENDING_MAX = 512 * 1024; // cap pending-line buffer to prevent local DoS

export function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
  let captured = "";
  let truncated = false;

  // Redact the LIVE stream on line boundaries so a secret split across chunks
  // isn't emitted un-redacted (the returned capture is redacted wholesale too).
  let linePending = "";
  let linePendingOverflow = false;
  const emit = (chunk: string) => {
    if (linePendingOverflow) {
      const nl = chunk.indexOf("\n");
      if (nl !== -1) {
        // Overflow cleared: process remainder after newline normally.
        linePending = chunk.slice(nl + 1);
        linePendingOverflow = false;
        // Fall through to flush lines from the overflow remainder.
      } else {
        return;
      }
    } else {
      linePending += chunk;
    }
    if (linePending.length > LINE_PENDING_MAX) {
      input.onData?.(redactSecrets(linePending.slice(0, LINE_PENDING_MAX)));
      const remainder = linePending.slice(LINE_PENDING_MAX);
      linePending = "";
      linePendingOverflow = true;
      const nl = remainder.indexOf("\n");
      if (nl !== -1) {
        linePending = remainder.slice(nl + 1);
        linePendingOverflow = false;
        // Fall through to process new linePending
      } else {
        return;
      }
    }
    const nl = linePending.lastIndexOf("\n");
    if (nl !== -1) {
      input.onData?.(redactSecrets(linePending.slice(0, nl + 1)));
      linePending = linePending.slice(nl + 1);
    }
  };
  const flushPending = () => {
    if (linePending) {
      input.onData?.(redactSecrets(linePending));
      linePending = "";
    }
  };
  const append = (buf: Buffer): void => {
    const s = buf.toString("utf8");
    emit(s);
    if (captured.length < input.maxCaptureBytes) {
      captured += s;
      if (captured.length >= input.maxCaptureBytes) {
        captured = captured.slice(0, input.maxCaptureBytes);
        truncated = true;
      }
    }
  };

  return new Promise<BoundedProcessResult>((resolve) => {
    const done = (exitCode: number | null, signal: string | null, timedOut: boolean) =>
      resolve({ exitCode, signal, timedOut, truncated, captured: redactSecrets(captured) });

    // Never start the process if we were already aborted.
    if (input.signal.aborted) {
      resolve({ exitCode: null, signal: "SIGABRT", timedOut: false, truncated: false, captured: "" });
      return;
    }

    // Own process group so a timeout/abort can take down the whole child tree.
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: input.shell ?? false,
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
    }, input.timeoutMs);
    const onAbort = () => killGroup();
    input.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      flushPending(); // emit any trailing partial line (redacted)
      done(exitCode, signal, timedOut);
    };
    child.on("error", (err) => {
      append(Buffer.from(`\n[spawn error] ${err.message}\n`));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
