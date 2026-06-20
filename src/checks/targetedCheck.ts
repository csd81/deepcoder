/**
 * Phase 10H — Targeted Check Runner.
 *
 * Composes ephemeral CheckConfig objects from a TestTargetPlan and runs them
 * through the existing runCheck infrastructure. Commands are built from
 * configured templates (never from model text), paths are shell-quoted, and
 * every composed command still passes through classifyCommand — a denied
 * command is refused and the fallback check is used instead.
 */

import { runCheck, CheckRefusedError, type RunCheckOptions } from "./runner.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { CheckRun } from "../session/checkRuns.js";
import type { TestTargetPlan, TargetedCheckCommand } from "./testTargetPlanner.js";

export interface TargetedCheckResult {
  /** Results from each targeted command that was actually run. */
  targetedRuns: { command: TargetedCheckCommand; run: CheckRun }[];
  /** Commands that were refused by the classifier (not run). */
  refused: TargetedCheckCommand[];
  /** Whether a fallback check should be used. */
  fallbackRequired: boolean;
  /** The fallback check name, if any. */
  fallbackCheck?: string;
}

export interface TargetedCheckOptions extends RunCheckOptions {
  /** Timeout per targeted command (default 180000). */
  timeoutMs?: number;
}

/**
 * Run targeted checks from a plan. Each command is composed into an ephemeral
 * CheckConfig, classifier-gated, and run through runCheck. A denied command
 * is NOT run — it's recorded as refused and the caller should use the fallback.
 *
 * Returns a summary of what ran, what was refused, and whether fallback is
 * still needed.
 */
export async function runTargetedChecks(
  plan: TestTargetPlan,
  opts: TargetedCheckOptions,
): Promise<TargetedCheckResult> {
  const targetedRuns: { command: TargetedCheckCommand; run: CheckRun }[] = [];
  const refused: TargetedCheckCommand[] = [];

  for (const cmd of plan.commands) {
    const check: CheckConfig = {
      command: cmd.command,
      timeoutMs: opts.timeoutMs ?? 180_000,
    };

    // Classifier gate: a denied command is NOT run.
    if (classifyCommand(check.command) === "deny") {
      refused.push(cmd);
      continue;
    }

    try {
      const run = await runCheck(cmd.label, check, opts);
      targetedRuns.push({ command: cmd, run });
    } catch (err) {
      if (err instanceof CheckRefusedError) {
        refused.push(cmd);
      } else {
        // Internal setup failure — rethrow
        throw err;
      }
    }
  }

  // Fallback is required if the plan says so, or if ALL commands were refused.
  const allRefused = plan.commands.length > 0 && refused.length === plan.commands.length;
  const fallbackRequired = plan.fallbackRequired || allRefused;

  return {
    targetedRuns,
    refused,
    fallbackRequired,
    fallbackCheck: fallbackRequired ? (plan.fallbackCheck ?? "phase") : undefined,
  };
}
