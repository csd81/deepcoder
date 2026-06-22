import chalk from "chalk";
import { runCheck } from "../checks/runner.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import type { UserCommandConfig } from "../config/fileConfig.js";
import type { Session } from "./repl.js";

/**
 * Execute a user-defined slash command.
 *
 * Commands flow through the command-classifier gate (a denied command is refused
 * even if configured), run in the sandbox when configured, and stream output
 * live to the terminal. Unlike `/check`, output is ephemeral — it is NOT persisted
 * to `.deepcoder/runs/`.
 */
export async function runUserCommand(
  name: string,
  config: UserCommandConfig,
  session: Session,
): Promise<void> {
  // 1. Classify first — a denied command is refused even if configured.
  const classification = classifyCommand(config.command);
  if (classification === "deny") {
    console.log(chalk.red(`Command "${config.command}" was denied by the command classifier.`));
    return;
  }

  // 2. Run with streaming output.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const result = await runCheck(name, config, {
      workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
      signal: controller.signal,
      onData: (chunk) => process.stdout.write(chunk), // stream live
      sandbox: session.config.sandbox,
    });

    const status = result.timedOut
      ? chalk.red("timed out")
      : result.exitCode === 0
        ? chalk.green(`passed (exit 0)`)
        : chalk.red(`failed (exit ${result.exitCode ?? "?"}${result.signal ? `, ${result.signal}` : ""})`);
    console.log(chalk.dim(`\n→ ${status} · ${Math.round(result.durationMs)}ms`));
  } catch (err) {
    console.log(chalk.red(`user command failed: ${(err as Error).message}`));
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
