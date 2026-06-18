import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { ToolInvocation, ToolPreview } from "../tools/types.js";

/**
 * Render an invocation (and its preview, if any) and ask the user to approve.
 * Returns true if approved. Defaults to "no" on empty input.
 */
export async function promptForApproval(
  invocation: ToolInvocation,
  preview?: ToolPreview,
): Promise<boolean> {
  stdout.write("\n" + chalk.yellow("● permission required: ") + invocation.describe() + "\n");
  if (preview?.description) {
    stdout.write(chalk.dim(preview.description) + "\n");
  }
  if (preview?.diff) {
    stdout.write(renderDiff(preview.diff) + "\n");
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(chalk.cyan("Approve? [y/N] "))).trim().toLowerCase();
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
