/**
 * Phase 10O — Clipboard adapter.
 *
 * Detects a supported clipboard command on the current platform and copies
 * redacted, bounded text through it. Fully injectable for tests — no real
 * subprocess, no real clipboard needed.
 *
 * Safety:
 * - `shell: false` (no shell interpolation)
 * - Timeout after 3 seconds
 * - No network
 * - No secrets — caller must redact before calling copyToClipboard
 */

import { spawn } from "node:child_process";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CopyResult {
  ok: boolean;
  backend?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Spawn function type (injectable for tests)                        */
/* ------------------------------------------------------------------ */

export interface SpawnInput {
  file: string;
  args: string[];
  /** Text to write to stdin of the spawned process. */
  input: string;
  /** Wall-clock timeout in milliseconds. */
  timeoutMs: number;
}

export type SpawnFn = (input: SpawnInput) => Promise<CopyResult>;

/* ------------------------------------------------------------------ */
/*  Clipboard command detection                                        */
/* ------------------------------------------------------------------ */

export interface ClipboardCommand {
  file: string;
  args: string[];
}

/**
 * Detect which clipboard command is available on the current platform.
 * Returns null when none is found.
 *
 * Detection order:
 *   macOS:         pbcopy
 *   Linux/Wayland: wl-copy (when WAYLAND_DISPLAY is set)
 *   Linux/X11:     xclip -selection clipboard (when DISPLAY is set, no Wayland)
 *   Windows:       Not detected by default (no Win32 clipboard CLI in wide use)
 */
export function detectClipboardCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ClipboardCommand | null {
  if (platform === "darwin") {
    return { file: "pbcopy", args: [] };
  }

  if (platform === "linux" || platform === "win32") {
    // Wayland (Linux only)
    if (platform === "linux" && env.WAYLAND_DISPLAY) {
      return { file: "wl-copy", args: [] };
    }

    // X11 (Linux or WSL)
    if (env.DISPLAY) {
      return { file: "xclip", args: ["-selection", "clipboard"] };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Default spawn implementation (real child_process.spawn)            */
/* ------------------------------------------------------------------ */

/**
 * Default spawn function that uses `child_process.spawn` with `shell: false`.
 * Writes `input` to stdin, waits for the process to exit, and enforces a
 * timeout. Never throws — errors are returned as CopyResult.
 */
export const defaultSpawn: SpawnFn = async (input: SpawnInput): Promise<CopyResult> => {
  return new Promise<CopyResult>((resolve) => {
    let timedOut = false;
    let stderr = "";

    const child = spawn(input.file, input.args, {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    // Write input to stdin
    child.stdin.write(input.input, "utf8");
    child.stdin.end();

    // Capture bounded stderr
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8");
        if (stderr.length > 4096) stderr = stderr.slice(0, 4096);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT means the command is not installed
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ ok: false, error: `clipboard unavailable: install ${input.file}` });
      } else {
        resolve({ ok: false, error: `clipboard error: ${err.message}` });
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: "clipboard timed out" });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : "";
        resolve({ ok: false, error: `clipboard exited ${code}${detail}` });
        return;
      }
      resolve({ ok: true, backend: input.file });
    });
  });
};

/* ------------------------------------------------------------------ */
/*  Copy to clipboard                                                  */
/* ------------------------------------------------------------------ */

/**
 * Copy `text` to the system clipboard.
 *
 * @param text - Pre-redacted, pre-bounded text to copy.
 * @param opts.command - Clipboard command to use. When null, clipboard is unavailable.
 *   When undefined, auto-detected from environment.
 * @param opts.spawn - Spawn function override (default: real spawn).
 * @param opts.timeoutMs - Timeout in milliseconds (default: 3000).
 */
export async function copyToClipboard(
  text: string,
  opts?: {
    command?: ClipboardCommand | null;
    spawn?: SpawnFn;
    timeoutMs?: number;
  },
): Promise<CopyResult> {
  const command = opts?.command !== undefined ? opts.command : detectClipboardCommand(process.env, process.platform);
  const spawnFn = opts?.spawn ?? defaultSpawn;
  const timeoutMs = opts?.timeoutMs ?? 3000;

  if (!command) {
    return { ok: false, error: "clipboard unavailable: install wl-copy, xclip, or pbcopy" };
  }

  return spawnFn({
    file: command.file,
    args: command.args,
    input: text,
    timeoutMs,
  });
}
