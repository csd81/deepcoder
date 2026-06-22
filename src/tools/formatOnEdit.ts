/**
 * Format-on-edit: after a successful edit_file/write_file, if the changed file
 * matches a configured glob, run the configured formatter command on that file.
 *
 * Safety: classifier-gated, sandboxed, timed out — same as diagnostics and checks.
 * Output is NOT shown to the model or persisted — only a brief transcript notice.
 */

import { classifyCommand } from "../permissions/commandClassifier.js";
import { runBoundedProcess } from "../process/runBoundedProcess.js";
import { globMatch } from "../diagnostics/matcher.js";
import type { SandboxConfig } from "../sandbox/types.js";
import type { FormatConfig } from "../config/fileConfig.js";

/**
 * Check whether a workspace-relative file path matches any of the configured
 * glob patterns. When no patterns are configured, defaults to matching everything.
 */
export function shouldFormat(file: string, config: FormatConfig): boolean {
  const patterns = config.match ?? ["**/*"];
  return patterns.some((p) => globMatch(file, p));
}

export interface FormatFileResult {
  formatted: boolean;
  error?: string;
}

/**
 * Run the configured formatter on a single file.
 *
 * Commands are classifier-gated (a denied command is refused), sandboxed via
 * runBoundedProcess, and timed out. The caller is responsible for providing an
 * AbortSignal.
 */
export async function formatFile(
  file: string,
  config: FormatConfig,
  deps: {
    workspaceRoot: string;
    sandbox?: SandboxConfig;
    signal: AbortSignal;
  },
): Promise<FormatFileResult> {
  const command = `${config.command} ${shellQuote(file)}`;

  // Classifier gate: a denied command is refused — never run.
  if (classifyCommand(command) === "deny") {
    return { formatted: false, error: "denied by command classifier" };
  }

  // Apply sandbox wrapping if configured.
  let toRun = command;
  if (deps.sandbox) {
    const { wrapCommand } = await import("../sandbox/index.js");
    toRun = wrapCommand({ command, workspaceRoot: deps.workspaceRoot }, deps.sandbox).command;
  }

  const result = await runBoundedProcess({
    file: toRun,
    args: [],
    shell: true,
    cwd: deps.workspaceRoot,
    env: process.env,
    signal: deps.signal,
    timeoutMs: config.timeoutMs ?? 30_000,
    maxCaptureBytes: 1024,
  });

  if (result.exitCode !== 0) {
    return {
      formatted: false,
      error: `exit ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`,
    };
  }

  return { formatted: true };
}

/**
 * POSIX shell single-quote a path.
 */
function shellQuote(p: string): string {
  const s = p.replace(/\\/g, "/");
  return `'${s.replace(/'/g, "'\\''")}'`;
}
