import type { CheckConfig } from "../config/fileConfig.js";

/**
 * Whether `command` is EXACTLY an operator-configured check command
 * (`config.checks[*].command`), modulo whitespace normalization.
 *
 * Used to let the model close its own verify loop in headless/non-interactive
 * mode: the approval prompt there auto-DENIES (no TTY to answer), which blocks
 * the model from running `tsc`/tests to verify its work. A configured check is
 * operator-defined and therefore trusted, so running exactly that command is
 * safe to auto-approve. Anything else (a superset, a chained command, an
 * arbitrary command) does NOT match → still denied. This never overrides the
 * command classifier: a check that the classifier denies never reaches the
 * approval step at all, so this can only upgrade an "ask" to "allow" for an
 * exact, pre-vetted check command.
 */
export function isConfiguredCheckCommand(
  command: string | undefined,
  checks: Record<string, CheckConfig>,
): boolean {
  if (!command) return false;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const target = norm(command);
  if (!target) return false;
  return Object.values(checks).some((c) => norm(c.command) === target);
}
