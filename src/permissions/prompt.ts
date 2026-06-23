import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { ToolInvocation, ToolPreview } from "../tools/types.js";
import { capDiffPreview } from "../tools/diff.js";

/**
 * Render an invocation (and its preview, if any) and ask the user to approve.
 * Returns true if approved. Defaults to "no" on empty input.
 */
export async function promptForApproval(
  invocation: ToolInvocation,
  preview?: ToolPreview,
): Promise<boolean> {
  // No interactive terminal (headless one-shot, --solve, piped, in-container):
  // we cannot ask, so deny safely. The agent loop turns this into a "rejected"
  // tool result and continues — never blocking on stdin that will never answer.
  if (!stdin.isTTY) {
    stdout.write(
      "\n" + chalk.yellow("● permission required — auto-denied (no interactive terminal): ") +
        invocation.describe() + "\n",
    );
    return false;
  }
  stdout.write("\n" + chalk.yellow("● permission required: ") + invocation.describe() + "\n");
  if (preview?.description) {
    stdout.write(chalk.dim(preview.description) + "\n");
  }
  if (preview?.diff) {
    // Cap the human-facing PREVIEW so a hostile edit can't hide inside a large
    // benign-looking diff at the prompt. The full diff is still applied on
    // approval — only what we render here is truncated.
    stdout.write(renderDiff(capDiffPreview(preview.diff)) + "\n");
  }

  return confirm("Approve?");
}

/** Generic y/N confirmation. Defaults to "no" on empty/EOF input, and on a
 *  non-interactive stdin (no TTY) returns "no" without blocking on a read. */
export async function confirm(message: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(chalk.cyan(`${message} [y/N] `))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function renderDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return chalk.green(line);
      if (line.startsWith("-")) return chalk.red(line);
      if (line.startsWith("@@")) return chalk.cyan(line);
      return chalk.dim(line);
    })
    .join("\n");
}
