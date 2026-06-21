import { stdout } from "node:process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import type { Session } from "./repl.js";
import { runSolveLoop } from "../solve/solver.js";
import type { SolveOptions, SolveResult } from "../solve/types.js";
import type { UiEvent } from "../ui/events.js";
import { Git } from "../workspace/git.js";
import { redactSecrets } from "../workspace/redact.js";
import { hookCtx, hooksFor } from "./repl.js";
import { runAdvisoryHooks } from "../hooks/runner.js";
import type { HookEvent } from "../hooks/types.js";
import { buildReproInstruction } from "../agent/systemPrompt.js";
import { runExplorer } from "../subagents/contextExplorer.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";

/** Build an advisory solve hook for `event`; null if no such hooks are enabled. */
function solveHook(session: Session, event: HookEvent, key: string) {
  return async (payload: Record<string, unknown>): Promise<string[]> => {
    const list = hooksFor(session, event);
    if (!list) return [];
    const out = await runAdvisoryHooks(event, list, [key], payload, hookCtx(session));
    for (const w of out.warnings) stdout.write(chalk.yellow(`\nhook: ${w}\n`));
    return out.context;
  };
}

/**
 * Drive the closed-loop solver for one task and render progress + a final
 * summary. Installs its own SIGINT→abort so Ctrl-C stops the whole solve
 * (agent edits + checks). `runAgent` runs the agent loop for one attempt.
 */
export async function runSolveCommand(
  session: Session,
  opts: SolveOptions,
  runAgent: () => Promise<void>,
  onUiEvent?: (e: UiEvent) => void,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  let checkStreaming = false;
  const label = opts.checkName ?? "repro"; // the loop verifies against the repro when no check is named
  // Phase 5C: a constrained turn that writes one failing test, reusing the same
  // agent loop. The issue is included so the model knows what to reproduce.
  const runReproTurn =
    opts.repro === "auto"
      ? async (reproPath: string) => {
          session.messages.push({ role: "user", content: `${opts.task}\n\n${buildReproInstruction(reproPath)}` });
          await runAgent();
        }
      : undefined;
  // Telemetry (headless eval only): hash the working-tree patch each attempt so
  // we can detect repeated/empty edits. Git stays out of the solver core.
  const wantTelemetry = !!session.config.solveTelemetry;
  const git = wantTelemetry ? new Git(session.executionRoot ?? session.config.workspaceRoot) : null;
  const isRepo = git ? await git.isRepo() : false;
  const snapshotPatch = wantTelemetry
    ? async () => {
        if (!git || !isRepo) return null;
        const diff = await git.diff();
        return {
          hash: createHash("sha256").update(diff).digest("hex").slice(0, 16),
          bytes: Buffer.byteLength(diff),
        };
      }
    : undefined;
  // ---- Phase 8D: preflight context gathering (before attempt 1) ----
  let preflightExplorerTurns = 0;
  let preflightFilesCited = 0;
  let preflightContextBytes = 0;
  if (session.config.context.preflight) {
    stdout.write(chalk.dim(`Preflight: exploring (max ${session.config.context.explorerMaxTurns} turns)…\n`));
    const { brief, trace } = await runExplorer(opts.task, {
      workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
      provider: session.provider,
      parentModel: session.config.model,
      contextBudgetTokens: session.config.contextBudgetTokens,
      compactAt: session.config.compactAt,
      signal: controller.signal,
    });
    preflightExplorerTurns = trace.toolsCalled.length;
    preflightFilesCited = brief.relevantFiles.length;
    const rendered = renderExplorerBrief(brief, session.config.context.preflightMaxBytes);
    if (rendered) {
      preflightContextBytes = Buffer.byteLength(rendered, "utf8");
      session.messages.push({ role: "system", content: rendered });
      stdout.write(chalk.dim(`Preflight: injected ${preflightContextBytes}B brief.\n`));
    } else {
      stdout.write(chalk.dim("Preflight: brief was empty, skipped injection.\n"));
    }
  }

  try {
    const result = await runSolveLoop(session, opts, {
      runAgent,
      runReproTurn,
      signal: controller.signal,
      snapshotPatch,
      onUiEvent,
      onProgress: (e) => {
        if (e.type === "attempt-start") {
          stdout.write(chalk.cyan(`\nsolve attempt ${e.index}/${e.max}\n`));
        } else if (e.type === "check-result") {
          if (checkStreaming) {
            stdout.write("\n");
            checkStreaming = false;
          }
          const status = e.timedOut
            ? chalk.red("timed out")
            : e.passed
              ? chalk.green("passed (exit 0)")
              : chalk.red(`failed (exit ${e.exitCode ?? "?"})`);
          stdout.write(`check ${label}: ${status} · run ${e.runId}\n`);
        } else if (e.type === "retrying") {
          stdout.write(chalk.dim("retrying with a redacted failure summary…\n"));
        } else if (e.type === "repro") {
          if (checkStreaming) {
            stdout.write("\n");
            checkStreaming = false;
          }
          if (e.phase === "generated") stdout.write(chalk.dim(`repro generated: ${e.path}\n`));
          else if (e.phase === "validated") stdout.write(chalk.green(`repro validated red on the buggy tree: ${e.path}\n`));
          else stdout.write(chalk.yellow(`repro invalid (discarded): ${e.reason ?? "did not capture the bug"}\n`));
        }
      },
      onCheckData: (chunk) => {
        checkStreaming = true;
        stdout.write(chalk.dim(chunk));
      },
      onPostCheck: (info) => solveHook(session, "PostCheck", label)({ check: info }),
      onSolveAttemptEnd: (info) => solveHook(session, "SolveAttemptEnd", label)({ solve: info }),
    });

    // Attach preflight telemetry to the result (Phase 8D).
    if (session.config.context.preflight) {
      result.preflightPerformed = true;
      result.preflightExplorerTurns = preflightExplorerTurns;
      result.preflightFilesCited = preflightFilesCited;
      result.preflightContextBytes = preflightContextBytes;
    }

    if (session.config.solveTelemetry) {
      await writeTelemetry(session.config.solveTelemetry, session, opts, result);
    }

    if (result.refusal) {
      stdout.write(chalk.red(`\n${result.refusal}\n`));
      return;
    }
    const changed = [...session.writeTracker].map((p) => path.basename(p));
    const verdict = result.solved
      ? chalk.green(`solved in ${result.attempts.length} attempt(s)`)
      : chalk.yellow(`not solved after ${result.attempts.length} attempt(s)`);
    const oracleNote = result.repro?.usedAsOracle
      ? ` · oracle: generated repro (best-effort)${result.repro.tautological ? " ⚠ shallow" : ""}`
      : ` · check "${label}"`;
    stdout.write(
      `\n${verdict}${oracleNote}` +
        (result.repro?.kept ? ` · repro kept: ${result.repro.path}` : "") +
        (changed.length ? ` · changed: ${changed.join(", ")}` : " · no files changed") +
        (result.lastRunId ? ` · last run ${result.lastRunId}` : "") +
        "\n",
    );
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Write a machine-readable telemetry record of one solve run (headless eval).
 * Raw patches are never stored — only a hash + byte count — and the whole JSON
 * is re-redacted before write (the per-attempt failure summary is already
 * redacted upstream; this is defense-in-depth). Best-effort: never throws.
 */
async function writeTelemetry(
  filePath: string,
  session: Session,
  opts: SolveOptions,
  result: SolveResult,
): Promise<void> {
  try {
    const record = {
      checkName: opts.checkName ?? null,
      maxAttempts: opts.maxAttempts,
      solved: result.solved,
      refusal: result.refusal ?? null,
      attemptsCount: result.attempts.length,
      lastRunId: result.lastRunId ?? null,
      repro: result.repro
        ? {
            generated: result.repro.generated,
            valid: result.repro.valid,
            usedAsOracle: result.repro.usedAsOracle,
            tautological: result.repro.tautological,
            kept: result.repro.kept,
            path: result.repro.path ?? null,
            reason: result.repro.reason ?? null,
          }
        : null,
      preflightPerformed: result.preflightPerformed ?? false,
      preflightExplorerTurns: result.preflightExplorerTurns ?? 0,
      preflightFilesCited: result.preflightFilesCited ?? 0,
      preflightContextBytes: result.preflightContextBytes ?? 0,
      changedFiles: [...session.writeTracker].map((p) => path.basename(p)),
      attempts: result.attempts.map((a) => ({
        index: a.index,
        checkPassed: a.checkPassed,
        checkTimedOut: a.checkTimedOut,
        checkRunId: a.checkRunId ?? null,
        patchHash: a.patchHash ?? null,
        patchBytes: a.patchBytes ?? null,
        failureSummary: a.failureSummary ?? null,
      })),
    };
    await writeFile(filePath, redactSecrets(JSON.stringify(record, null, 2)), "utf8");
  } catch {
    /* telemetry is best-effort; a write failure must not fail the solve */
  }
}
