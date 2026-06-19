import { stdout } from "node:process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import type { Session } from "./repl.js";
import { runSolveLoop } from "../solve/solver.js";
import type { SolveOptions, SolveResult } from "../solve/types.js";
import { Git } from "../workspace/git.js";
import { redactSecrets } from "../workspace/redact.js";
import { hookCtx, hooksFor } from "./repl.js";
import { runAdvisoryHooks } from "../hooks/runner.js";
import type { HookEvent } from "../hooks/types.js";

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
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  let checkStreaming = false;
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
  try {
    const result = await runSolveLoop(session, opts, {
      runAgent,
      signal: controller.signal,
      snapshotPatch,
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
          stdout.write(`check ${opts.checkName}: ${status} · run ${e.runId}\n`);
        } else if (e.type === "retrying") {
          stdout.write(chalk.dim("retrying with a redacted failure summary…\n"));
        }
      },
      onCheckData: (chunk) => {
        checkStreaming = true;
        stdout.write(chalk.dim(chunk));
      },
      onPostCheck: (info) => solveHook(session, "PostCheck", opts.checkName)({ check: info }),
      onSolveAttemptEnd: (info) => solveHook(session, "SolveAttemptEnd", opts.checkName)({ solve: info }),
    });

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
    stdout.write(
      `\n${verdict} · check "${opts.checkName}"` +
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
      checkName: opts.checkName,
      maxAttempts: opts.maxAttempts,
      solved: result.solved,
      refusal: result.refusal ?? null,
      attemptsCount: result.attempts.length,
      lastRunId: result.lastRunId ?? null,
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
