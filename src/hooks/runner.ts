import { spawn } from "node:child_process";
import { matchHooks } from "./matcher.js";
import type { HookConfig, HookOutcome, PreToolUseInput } from "./types.js";
import type { SandboxConfig } from "../sandbox/types.js";
import { wrapCommand } from "../sandbox/index.js";
import { redactSecrets } from "../workspace/redact.js";

export interface HookRunContext {
  workspaceRoot: string;
  sandbox?: SandboxConfig;
  signal?: AbortSignal;
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_TIMEOUT_MS = 300_000;

/**
 * Run PreToolUse hooks in declared order. For each matched hook:
 * - Runs via wrapCommand with network forced off and a bounded timeout.
 * - Fail-open: non-zero exit other than 2, crash, bad JSON, timeout → warn + continue.
 * - Deny requires exit code 2 OR stdout JSON {"decision":"deny"}.
 * - Reason is redacted with redactSecrets.
 * - Returns the FIRST deny, else {decision:"none"}.
 * Never throws.
 */
export async function runPreToolUseHooks(
  hooks: HookConfig[],
  input: PreToolUseInput,
  ctx: HookRunContext,
): Promise<HookOutcome> {
  const matched = matchHooks(hooks, input);

  for (const hook of matched) {
    try {
      const timeoutMs = Math.min(
        hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        MAX_HOOK_TIMEOUT_MS,
      );

      // Build the sandbox config with network forced off.
      const sandboxConfig: SandboxConfig = ctx.sandbox ?? {
        mode: "off",
        network: "off",
        workspaceWrite: true,
        extraMounts: [],
        timeoutMs: 120_000,
        fallback: "ask",
      };
      const sandboxForHook: SandboxConfig = {
        ...sandboxConfig,
        network: "off",
      };

      const wrapped = wrapCommand(
        { command: hook.command, workspaceRoot: ctx.workspaceRoot, network: "off" },
        sandboxForHook,
      );

      const result = await runHookCommand(wrapped.command, timeoutMs, ctx.signal);

      // Check for deny signals
      if (result.exitCode === 2) {
        // Exit code 2 is a deny signal. Parse stdout for a reason.
        const parsed = tryParseJson(result.stdout);
        const reason = parsed?.reason
          ? redactSecrets(String(parsed.reason))
          : `Hook "${hook.name}" denied the action`;
        return { decision: "deny", reason };
      }

      // Also check stdout for {"decision":"deny"} even on exit 0
      const parsed = tryParseJson(result.stdout);
      if (parsed?.decision === "deny") {
        const reason = parsed?.reason
          ? redactSecrets(String(parsed.reason))
          : `Hook "${hook.name}" denied the action`;
        return { decision: "deny", reason };
      }
    } catch {
      // Any unexpected error (crash, timeout, etc.) is a no-op — fail-open.
      // We just continue to the next hook.
    }
  }

  return { decision: "none" };
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
}

function runHookCommand(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // No detached — we want the timeout to be able to kill the process group
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null, _sig: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // ignore
        }
      }
      resolve({ exitCode: timedOut ? null : exitCode, stdout });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null, "SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        finish(null, "SIGABRT");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", () => {
      finish(null, null);
    });

    child.on("close", (code, sig) => {
      finish(code, sig);
    });
  });
}

function tryParseJson(text: string): Record<string, unknown> | null {
  // Try to find a JSON object in the output (it may have other log lines)
  const trimmed = text.trim();
  // First try the whole output
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Try to find a JSON object anywhere in the output
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // Not valid JSON
      }
    }
  }
  return null;
}
