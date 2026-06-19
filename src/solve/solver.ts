import type { Session } from "../cli/repl.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { loadCheckRun } from "../session/checkRuns.js";
import { summarizeCheckFailure, buildRetryPrompt } from "./failureSummary.js";
import type { SolveOptions, SolveResult, SolveAttempt } from "./types.js";

export type SolveProgress =
  | { type: "attempt-start"; index: number; max: number }
  | { type: "check-result"; index: number; passed: boolean; timedOut: boolean; exitCode: number | null; runId: string }
  | { type: "retrying"; index: number };

export interface SolveDeps {
  /** Runs the agent loop on `session.messages` for one attempt (mutates them). */
  runAgent: () => Promise<void>;
  signal: AbortSignal;
  onProgress?: (e: SolveProgress) => void;
  /** Live (already-redacted) check output sink. */
  onCheckData?: (chunk: string) => void;
  /**
   * Optional, git-agnostic snapshot of the patch the agent just produced, used
   * only for telemetry (detecting repeated/empty edits). Injected by the caller
   * so the solver core stays free of git/SWE logic. Failures are swallowed.
   */
  snapshotPatch?: () => Promise<{ hash: string; bytes: number } | null>;
  /**
   * Advisory lifecycle hooks (Phase 7B), injected by the caller so the solver
   * core stays free of hook/sandbox wiring. Each returns context strings to fold
   * into the next retry prompt (and surfaces its own warnings). Failures are
   * swallowed. PostCheck fires after each check; SolveAttemptEnd after each attempt.
   */
  onPostCheck?: (info: { name: string; exitCode: number | null; timedOut: boolean; runId: string }) => Promise<string[]>;
  onSolveAttemptEnd?: (info: { attempt: number; maxAttempts: number; checkPassed: boolean; checkRunId: string }) => Promise<string[]>;
}

/**
 * Closed-loop solver: edit → run a user-configured check → on failure feed a
 * bounded/redacted summary back → retry, up to `maxAttempts`. The check is never
 * model-chosen (looked up by name from config and classifier-gated), raw output
 * never enters history (only the summary does), and there is no auto-rollback.
 */
export async function runSolveLoop(
  session: Session,
  opts: SolveOptions,
  deps: SolveDeps,
): Promise<SolveResult> {
  const attempts: SolveAttempt[] = [];
  const task = opts.task.trim();
  if (!task) return { solved: false, attempts, refusal: "No task provided." };

  const check = session.config.checks[opts.checkName];
  if (!check) {
    return { solved: false, attempts, refusal: `Unknown check "${opts.checkName}". See /checks.` };
  }
  if (classifyCommand(check.command) === "deny") {
    return {
      solved: false,
      attempts,
      refusal: `Check "${opts.checkName}" is blocked by the permission policy: ${check.command}`,
    };
  }

  const root = session.executionRoot ?? session.config.workspaceRoot; // isolated worktree when isolation is active
  // Attempt 1 starts from the task; later attempts append retry evidence.
  session.messages.push({ role: "user", content: task });

  let lastRunId: string | undefined;
  for (let i = 1; i <= opts.maxAttempts; i++) {
    if (deps.signal.aborted) break;
    deps.onProgress?.({ type: "attempt-start", index: i, max: opts.maxAttempts });

    await deps.runAgent();
    if (deps.signal.aborted) break;

    // Per-attempt checkpoint is best-effort and never fatal (no auto-rollback).
    if (session.recorder && session.config.checkpoints !== "off") {
      try {
        await session.recorder.finalize(`solve:attempt-${i}`);
      } catch {
        /* a checkpoint failure must not abort the solve */
      }
    }

    let run;
    try {
      run = await runCheck(opts.checkName, check, {
        workspaceRoot: root,
        signal: deps.signal,
        onData: deps.onCheckData,
        sandbox: session.config.sandbox,
      });
    } catch (err) {
      if (err instanceof CheckRefusedError) {
        return { solved: false, attempts, refusal: err.message, lastRunId };
      }
      throw err;
    }
    lastRunId = run.id;

    // Best-effort telemetry snapshot of the patch that was just verified.
    let patch: { hash: string; bytes: number } | null = null;
    if (deps.snapshotPatch) {
      try {
        patch = await deps.snapshotPatch();
      } catch {
        /* telemetry must never break the solve */
      }
    }

    const passed = !run.timedOut && run.exitCode === 0;
    deps.onProgress?.({
      type: "check-result",
      index: i,
      passed,
      timedOut: run.timedOut,
      exitCode: run.exitCode,
      runId: run.id,
    });

    // Advisory hooks (Phase 7B). Their injected context (if any) is folded into
    // the retry prompt below; failures never affect the solve.
    const hookContext: string[] = [];
    const fireHook = async (fn?: () => Promise<string[]>) => {
      if (!fn) return;
      try {
        hookContext.push(...(await fn()));
      } catch {
        /* advisory hooks must never break the solve */
      }
    };
    await fireHook(deps.onPostCheck && (() => deps.onPostCheck!({ name: opts.checkName, exitCode: run.exitCode, timedOut: run.timedOut, runId: run.id })));
    await fireHook(deps.onSolveAttemptEnd && (() => deps.onSolveAttemptEnd!({ attempt: i, maxAttempts: opts.maxAttempts, checkPassed: passed, checkRunId: run.id })));

    if (passed) {
      attempts.push({
        index: i,
        checkRunId: run.id,
        checkPassed: true,
        checkTimedOut: false,
        patchHash: patch?.hash,
        patchBytes: patch?.bytes,
      });
      return { solved: true, attempts, lastRunId };
    }

    // Read the stored (already-redacted) log and distill a bounded summary.
    const { log } = await loadCheckRun(root, run.id);
    const failureSummary = summarizeCheckFailure(run, log);
    attempts.push({
      index: i,
      checkRunId: run.id,
      checkPassed: false,
      checkTimedOut: run.timedOut,
      failureSummary,
      patchHash: patch?.hash,
      patchBytes: patch?.bytes,
    });

    if (i < opts.maxAttempts) {
      const retry = buildRetryPrompt(failureSummary, i);
      const withContext = hookContext.length ? `${retry}\n\n[hook context]\n${hookContext.join("\n")}` : retry;
      session.messages.push({ role: "user", content: withContext });
      deps.onProgress?.({ type: "retrying", index: i });
    }
  }

  return { solved: false, attempts, lastRunId };
}
