import { spawn } from "node:child_process";
import { matchHooks, matchHooksByKeys } from "./matcher.js";
import {
  CONTEXT_EVENTS,
  EMPTY_ADVISORY,
  type AdvisoryOutcome,
  type HookConfig,
  type HookEvent,
  type HookOutcome,
  type PreToolUseInput,
} from "./types.js";
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
const MAX_HOOK_OUTPUT_CHARS = 4_000;

/**
 * Run PreToolUse hooks in declared order (BLOCKING). For each matched hook:
 * - Runs via wrapCommand with network forced off and a bounded timeout, with the
 *   payload JSON on stdin.
 * - Fail-open: non-zero exit other than 2, crash, bad JSON, timeout → warn + continue.
 * - Deny requires exit code 2 OR stdout JSON {"decision":"deny"}.
 * - Reason is redacted. Returns the FIRST deny, else {decision:"none"}. Never throws.
 */
export async function runPreToolUseHooks(
  hooks: HookConfig[],
  input: PreToolUseInput,
  ctx: HookRunContext,
): Promise<HookOutcome> {
  const matched = matchHooks(hooks, input);
  const payload = JSON.stringify({ event: "PreToolUse", workspaceRoot: ctx.workspaceRoot, tool: input });

  for (const hook of matched) {
    try {
      const result = await runOne(hook, payload, ctx);
      if (result === null) continue; // crash/timeout — fail-open
      const parsed = tryParseJson(result.stdout);
      if (result.exitCode === 2 || parsed?.decision === "deny") {
        const reason = parsed?.reason
          ? redactSecrets(String(parsed.reason))
          : `Hook "${hook.name}" denied the action`;
        return { decision: "deny", reason };
      }
    } catch {
      // Any unexpected error is a no-op — fail-open.
    }
  }
  return { decision: "none" };
}

/**
 * Run advisory (non-blocking) hooks for `event` in declared order. Collects, in
 * order: WARN messages (any nonzero exit, {"decision":"warn"}, or a {"message"})
 * and — only for CONTEXT_EVENTS — injected {"context"} strings. Never denies,
 * never throws. `matchKeys` are matched against each hook's matcher (empty for
 * session-level events → all hooks match). `payload` is sent on stdin as JSON.
 */
export async function runAdvisoryHooks(
  event: HookEvent,
  hooks: HookConfig[],
  matchKeys: (string | undefined)[],
  payload: Record<string, unknown>,
  ctx: HookRunContext,
): Promise<AdvisoryOutcome> {
  if (!hooks || hooks.length === 0) return EMPTY_ADVISORY;
  const matched = matchHooksByKeys(hooks, matchKeys);
  if (matched.length === 0) return EMPTY_ADVISORY;
  const allowsContext = CONTEXT_EVENTS.includes(event);
  const stdin = JSON.stringify({ event, workspaceRoot: ctx.workspaceRoot, ...payload });

  const warnings: string[] = [];
  const context: string[] = [];
  for (const hook of matched) {
    try {
      const result = await runOne(hook, stdin, ctx);
      if (result === null) {
        warnings.push(`Hook "${hook.name}" failed (timeout/crash).`);
        continue;
      }
      const parsed = tryParseJson(result.stdout);
      // nonzero exit (other than a clean 0) is advisory-only here → warn.
      if (result.exitCode !== 0 && result.exitCode !== null) {
        const msg = parsed?.message ?? parsed?.reason;
        warnings.push(redactSecrets(msg ? String(msg) : `Hook "${hook.name}" exited ${result.exitCode}`).slice(0, MAX_HOOK_OUTPUT_CHARS));
      } else if (parsed) {
        if (parsed.decision === "warn" || parsed.message) {
          const msg = parsed.message ?? parsed.reason;
          if (msg) warnings.push(redactSecrets(String(msg)).slice(0, MAX_HOOK_OUTPUT_CHARS));
        }
        if (allowsContext && typeof parsed.context === "string" && parsed.context.trim()) {
          context.push(redactSecrets(parsed.context).slice(0, MAX_HOOK_OUTPUT_CHARS));
        }
      }
    } catch {
      // never let an advisory hook break the run
    }
  }
  return { warnings, context };
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
}

/** Sandbox-wrap + run one hook; null on crash/timeout. Network forced off. */
async function runOne(hook: HookConfig, stdin: string, ctx: HookRunContext): Promise<CommandResult | null> {
  const timeoutMs = Math.min(hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
  const sandboxConfig: SandboxConfig = ctx.sandbox ?? {
    mode: "off",
    network: "off",
    workspaceWrite: true,
    extraMounts: [],
    timeoutMs: 120_000,
    fallback: "ask",
  };
  const wrapped = wrapCommand(
    { command: hook.command, workspaceRoot: ctx.workspaceRoot, network: "off" },
    { ...sandboxConfig, network: "off" },
  );
  // Run from the execution root (ctx.workspaceRoot is the isolated workspace when
  // isolation is active). Without this, an unsandboxed/local-fallback hook would
  // run from the parent CLI cwd and inspect/mutate the wrong tree.
  return runHookCommand(wrapped.command, stdin, timeoutMs, ctx.workspaceRoot, ctx.signal);
}

function runHookCommand(
  command: string,
  stdin: string,
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult | null> {
  return new Promise((resolve) => {
    // detached so the timeout/abort `process.kill(-child.pid)` below takes down
    // the whole process group, not just the shell (grandchildren would survive).
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT_CHARS * 2) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", () => {}); // drained but ignored (logs only)

    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
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
      resolve(timedOut ? null : { exitCode, stdout });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, timeoutMs);

    const onAbort = () => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));

    // Feed the payload on stdin; a hook that ignores stdin is fine.
    try {
      child.stdin?.end(stdin);
    } catch {
      // ignore broken pipe
    }
  });
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // not JSON
      }
    }
  }
  return null;
}
