import { readFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Session } from "../cli/repl.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { loadCheckRun } from "../session/checkRuns.js";
import { summarizeCheckFailure, buildRetryPrompt } from "./failureSummary.js";
import {
  validateReproIsRed,
  isTautologicalRepro,
  deriveReproCommand,
  safeReproPath,
  isScratchReproPath,
} from "./repro.js";
import type { SolveOptions, SolveResult, SolveAttempt, ReproResult } from "./types.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { UiEvent } from "../ui/events.js";
import { redactSecrets } from "../workspace/redact.js";

export type SolveProgress =
  | { type: "attempt-start"; index: number; max: number }
  | { type: "check-result"; index: number; passed: boolean; timedOut: boolean; exitCode: number | null; runId: string }
  | { type: "retrying"; index: number }
  | { type: "repro"; phase: "generated" | "validated" | "invalid"; path: string; reason?: string };

export interface SolveDeps {
  /** Runs the agent loop on `session.messages` for one attempt (mutates them). */
  runAgent: () => Promise<void>;
  signal: AbortSignal;
  onProgress?: (e: SolveProgress) => void;
  /** Live (already-redacted) check output sink. */
  onCheckData?: (chunk: string) => void;
  /**
   * Structured UI events for a TUI/SDK consumer (check_start/output/done). The
   * solver core stays UI-agnostic — the caller maps these to its renderer/sink.
   */
  onUiEvent?: (e: UiEvent) => void;
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
  /**
   * Phase 5C — runs ONE constrained agent turn that writes a single failing test
   * at `reproPath` (and makes no product edits). Injected by the caller so the
   * solver core stays free of provider/agent details. Mirrors `runAgent`.
   */
  runReproTurn?: (reproPath: string) => Promise<void>;
}

/**
 * Closed-loop solver: edit → run a check → on failure feed a bounded/redacted
 * summary back → retry, up to `maxAttempts`. The check is never model-chosen
 * (looked up by name from config and classifier-gated), raw output never enters
 * history (only the summary does), and there is no auto-rollback.
 *
 * Phase 5C (opt-in, `repro: "auto"`): before the fix loop the solver can write
 * its own failing test and validate it goes red on the buggy tree. With no
 * configured check that validated repro becomes the success oracle (best-effort);
 * with a configured check the check stays the authority and the repro is only an
 * extra signal / regression artifact — it never self-grades.
 */
export async function runSolveLoop(
  session: Session,
  opts: SolveOptions,
  deps: SolveDeps,
): Promise<SolveResult> {
  const attempts: SolveAttempt[] = [];
  const task = opts.task.trim();
  if (!task) return { solved: false, attempts, refusal: "No task provided." };

  const reproEnabled = opts.repro === "auto";
  const root = session.executionRoot ?? session.config.workspaceRoot; // isolated worktree when isolation is active

  // Resolve the configured check (if any). When named it must exist and be allowed.
  const checkName = opts.checkName;
  const configuredCheck = checkName ? session.config.checks[checkName] : undefined;
  if (checkName && !configuredCheck) {
    return { solved: false, attempts, refusal: `Unknown check "${checkName}". See /checks.` };
  }
  if (configuredCheck && classifyCommand(configuredCheck.command) === "deny") {
    return {
      solved: false,
      attempts,
      refusal: `Check "${checkName}" is blocked by the permission policy: ${configuredCheck.command}`,
    };
  }
  if (!configuredCheck && !reproEnabled) {
    return {
      solved: false,
      attempts,
      refusal: "Nothing to verify against: configure a check (--check) or enable repro generation (--repro auto).",
    };
  }

  // ---- Phase 5C: repro generation (before any fix) ----
  let repro: ReproResult | undefined;
  let oracle: { name: string; config: CheckConfig } | undefined; // set only when the repro IS the authority
  if (reproEnabled) {
    if (!deps.runReproTurn) {
      // Can't generate; only fatal when the repro was the only possible oracle.
      if (!configuredCheck) {
        return { solved: false, attempts, refusal: "Repro generation is unavailable in this run; provide --check." };
      }
    } else {
      repro = await runReproPhase(session, opts, deps, root, !!configuredCheck);
      if (!configuredCheck) {
        if (!repro.valid) {
          return {
            solved: false,
            attempts,
            refusal: repro.reason ?? "Could not generate a valid repro; provide --check to verify against.",
            repro,
          };
        }
        const cmd = deriveReproCommand(repro.path!)!; // valid implies a derivable command
        oracle = { name: "repro", config: { command: cmd } };
      }
    }
  }

  // The configured check has authority; otherwise the validated repro is the oracle.
  const loopName = configuredCheck ? checkName! : oracle!.name;
  const loopCheck: CheckConfig = configuredCheck ?? oracle!.config;

  const finish = async (res: SolveResult): Promise<SolveResult> => {
    if (repro) {
      // Keep a valid, non-scratch repro as a regression test; discard scratch/invalid.
      repro.kept = repro.valid && !repro.tautological && !!repro.path && !isScratchReproPath(repro.path);
      if (repro.path && !repro.kept) await discardRepro(root, repro.path);
      res.repro = repro;
    }
    return res;
  };

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

    deps.onUiEvent?.({ type: "check_start", name: loopName, command: redactSecrets(loopCheck.command) });
    // Tee live check output to both the raw sink and the structured UI channel.
    const onCheckData = (chunk: string): void => {
      deps.onCheckData?.(chunk);
      deps.onUiEvent?.({ type: "check_output", name: loopName, chunk });
    };
    let run;
    try {
      run = await runCheck(loopName, loopCheck, {
        workspaceRoot: root,
        signal: deps.signal,
        onData: onCheckData,
        sandbox: session.config.sandbox,
        dependencyHealing: session.config.dependencyHealing,
      });
    } catch (err) {
      if (err instanceof CheckRefusedError) {
        return await finish({ solved: false, attempts, refusal: err.message, lastRunId });
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
    deps.onUiEvent?.({ type: "check_done", name: loopName, exitCode: run.exitCode, passed });
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
    await fireHook(deps.onPostCheck && (() => deps.onPostCheck!({ name: loopName, exitCode: run.exitCode, timedOut: run.timedOut, runId: run.id })));
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
      return await finish({ solved: true, attempts, lastRunId });
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

  return await finish({ solved: false, attempts, lastRunId });
}

/**
 * Run the constrained repro-generation turn and validate it goes red on the
 * current (buggy) tree. Never throws: any failure yields an invalid repro that
 * the caller falls back from (to a configured check, or a refusal). The repro
 * file is left on disk only while it might still be used; an invalid repro is
 * discarded here, a scratch oracle is discarded by the caller after the loop.
 */
async function runReproPhase(
  session: Session,
  opts: SolveOptions,
  deps: SolveDeps,
  root: string,
  hasConfiguredCheck: boolean,
): Promise<ReproResult> {
  const base: ReproResult = { generated: false, valid: false, usedAsOracle: false, tautological: false, kept: false };

  // Resolve a workspace-safe repro path (default: a scratch path under .deepcoder).
  const requested = opts.reproPath ?? `.deepcoder/repro/repro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.test.mjs`;
  const reproPath = safeReproPath(requested);
  if (!reproPath) return { ...base, reason: `Unsafe repro path "${requested}" (must stay inside the workspace).` };
  base.path = reproPath;

  // We must know how to run it; otherwise generating is pointless (skip the turn).
  const cmd = deriveReproCommand(reproPath);
  if (!cmd) {
    return { ...base, reason: `Cannot run a repro at "${reproPath}" (unsupported test file type; use .mjs/.js/.ts/.py).` };
  }

  // Constrained generation turn — best-effort; a thrown turn yields no file.
  try {
    await mkdir(path.dirname(path.join(root, reproPath)), { recursive: true });
    await deps.runReproTurn!(reproPath);
  } catch {
    return { ...base, reason: "The repro generation turn failed." };
  }

  let content: string;
  try {
    content = await readFile(path.join(root, reproPath), "utf8");
  } catch {
    return { ...base, reason: "The repro turn did not produce a test file." };
  }
  base.generated = true;
  deps.onProgress?.({ type: "repro", phase: "generated", path: reproPath });

  const taut = isTautologicalRepro(content);
  base.tautological = taut.tautological;

  // Validate red on the buggy tree via the shared, gated/sandboxed runner.
  let run;
  try {
    run = await runCheck("repro", { command: cmd }, {
      workspaceRoot: root,
      signal: deps.signal,
      onData: deps.onCheckData,
      sandbox: session.config.sandbox,
    });
  } catch {
    // A refused/erroring repro check can't establish red.
    await discardRepro(root, reproPath);
    return { ...base, reason: "The repro test could not be run." };
  }

  const red = validateReproIsRed(run);
  // A tautological/shallow test's non-zero exit can't be trusted as a real red.
  const valid = red.red && !taut.tautological;
  if (!valid) {
    const reason = !red.red ? red.reason : taut.reason ?? "the repro is shallow/tautological";
    await discardRepro(root, reproPath); // discard on invalid (repro_invalid)
    deps.onProgress?.({ type: "repro", phase: "invalid", path: reproPath, reason });
    return { ...base, valid: false, reason };
  }

  deps.onProgress?.({ type: "repro", phase: "validated", path: reproPath });
  return { ...base, valid: true, usedAsOracle: !hasConfiguredCheck };
}

/** Best-effort discard of a generated repro file (never throws). */
async function discardRepro(root: string, reproPath: string): Promise<void> {
  try {
    await unlink(path.join(root, reproPath));
  } catch {
    /* already gone / unwritable — nothing to clean up */
  }
}
