import { stdout } from "node:process";
import path from "node:path";
import chalk from "chalk";
import type { Session } from "./repl.js";
import { runSolveLoop } from "../solve/solver.js";
import type { SolveOptions } from "../solve/types.js";

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
  try {
    const result = await runSolveLoop(session, opts, {
      runAgent,
      signal: controller.signal,
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
    });

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
