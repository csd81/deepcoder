/**
 * Auto-model-selection — default the delegate worker's model.
 *
 * PROBLEM: the delegate path defaulted the worker model to Pro
 * (deepseek-v4-pro) regardless of task, paying double on easy slices.
 *
 * POLICY (pure, deterministic): an explicit model always wins; otherwise, when
 * auto-selection is enabled (default), pick Flash vs Pro up-front from the same
 * complexity heuristic the rest of the codebase uses (`scoreComplexity`), so
 * cheap tasks run on Flash. With auto disabled, default to Flash (cheaper).
 *
 * No model call, no I/O, no secrets in output. Fully unit-testable.
 */

import { scoreComplexity } from "../models/complexityScore.js";

export interface WorkerModelArgs {
  /** The worker task/goal text. */
  prompt: string;
  /** Files/areas in scope (e.g. allowedPaths length). */
  fileCount?: number;
  /** A check/test is configured for the worker. */
  hasCheck?: boolean;
  /** An explicitly chosen model id — always wins when truthy. */
  explicitModel?: string;
  /** Whether to auto-select via the scorer. Defaults to true when undefined. */
  modelAuto?: boolean;
  /** Flash model id. */
  flashModel?: string;
  /** Pro model id. */
  proModel?: string;
}

const DEFAULT_FLASH_MODEL = "deepseek-v4-flash";
const DEFAULT_PRO_MODEL = "deepseek-v4-pro";

/**
 * Resolve the model id for a delegated worker. PURE.
 *
 * Precedence:
 *   1. `explicitModel` (when truthy) — an operator/route override always wins.
 *   2. auto-selection (default; `modelAuto !== false`) — `scoreComplexity`
 *      decides Flash vs Pro from the prompt/scope/check signals.
 *   3. otherwise — Flash (the cheaper default).
 */
export function defaultWorkerModel(args: WorkerModelArgs): string {
  const flashModel = args.flashModel ?? DEFAULT_FLASH_MODEL;
  const proModel = args.proModel ?? DEFAULT_PRO_MODEL;

  // 1. An explicit model always wins.
  if (args.explicitModel) return args.explicitModel;

  // 2. Auto-selection (default on) — score complexity up front.
  if (args.modelAuto !== false) {
    const verdict = scoreComplexity({
      prompt: args.prompt,
      fileCount: args.fileCount,
      hasCheck: args.hasCheck,
    });
    return verdict.model === "pro" ? proModel : flashModel;
  }

  // 3. Auto disabled — cheaper default.
  return flashModel;
}
