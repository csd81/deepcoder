import chalk from "chalk";

/** Maximum number of characters of a diff to show in a confirmation preview. */
const DIFF_PREVIEW_LIMIT = 2000;

export interface GitAction {
  /** Human-readable command, e.g. "git reset --hard HEAD~1". */
  label: string;
  /** Optional one-line explanation, e.g. "Discards uncommitted changes". */
  detail?: string;
  /** Optional staged diff or status preview (truncated when shown). */
  diff?: string;
  /** How aggressively to guard the action. */
  dangerLevel: "safe" | "normal" | "dangerous";
}

/**
 * Prompt function injected by the caller. Kept as a dependency so this module
 * stays unit-testable (a fake records the prompt and returns a scripted answer)
 * and the caller can wire a real readline prompt later. This module never
 * touches stdin/readline directly.
 */
export type AskFn = (prompt: string) => Promise<string>;

/**
 * Show a preview of a git action and, unless it is read-only ("safe"), prompt
 * for confirmation via the injected `ask`.
 *
 * - "safe": returns true immediately, without calling `ask`.
 * - "normal": single `y/N` confirm; true only for "y" or "yes".
 * - "dangerous": prints a warning, then requires the full word "yes".
 *
 * The answer is trimmed and lowercased before comparison.
 */
export async function confirmGitAction(
  action: GitAction,
  ask: AskFn,
): Promise<boolean> {
  // Read-only operations need no confirmation.
  if (action.dangerLevel === "safe") return true;

  console.log(chalk.bold(`\nAbout to run: ${chalk.yellow(action.label)}`));
  if (action.detail) console.log(chalk.dim(action.detail));
  if (action.diff) {
    console.log(chalk.underline("\nPreview:"));
    let preview = action.diff.slice(0, DIFF_PREVIEW_LIMIT);
    if (action.diff.length > DIFF_PREVIEW_LIMIT) {
      preview += chalk.dim(
        `\n… (${action.diff.length - DIFF_PREVIEW_LIMIT} more characters truncated)`,
      );
    }
    console.log(preview);
  }

  if (action.dangerLevel === "dangerous") {
    console.log(chalk.red.bold("⚠ This action discards changes permanently."));
    const answer = (await ask("Type 'yes' to confirm: ")).trim().toLowerCase();
    if (answer !== "yes") {
      console.log(chalk.dim("Cancelled."));
      return false;
    }
    return true;
  }

  // "normal"
  const answer = (await ask("Proceed? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log(chalk.dim("Cancelled."));
    return false;
  }
  return true;
}
