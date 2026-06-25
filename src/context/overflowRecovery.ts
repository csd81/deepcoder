import type { AgentMessage } from "../providers/types.js";
import { estimateMessages } from "./tokenBudget.js";
import { compactIfNeeded, type CompactOptions } from "./compaction.js";

/**
 * Reactive context-overflow recovery: when the provider rejects a request as
 * too long (despite proactive compaction — token estimation is approximate and
 * tool schemas/provider overhead are hidden costs), force an *aggressive*
 * deterministic compaction so the same call can be retried once with a much
 * smaller payload.
 *
 * Pure (no LLM/Date/random). Preserves every protected field `compactIfNeeded`
 * already guarantees (original task, files touched, pending todos, last error)
 * and provider tool-call pairing. Returns `recovered: false` when the array
 * cannot shrink further, so the loop stops cleanly instead of looping.
 */
export interface OverflowRecoveryResult {
  recovered: boolean;
  before: number;
  after: number;
  reason: string;
}

export function recoverContextOverflow(
  messages: AgentMessage[],
  opts: CompactOptions & { aggressiveTailRatio?: number },
): OverflowRecoveryResult {
  const before = estimateMessages(messages);

  // Force-compact against a *fraction* of the real budget so the retained tail is
  // much smaller than a normal compaction would keep. compactIfNeeded's forced
  // tail target is `budget*0.3`, so passing `budget*(ratio/0.3)` yields a tail of
  // ~`budget*ratio`.
  const ratio = opts.aggressiveTailRatio ?? 0.15;
  const aggressiveBudget = Math.max(1, Math.floor(opts.budgetTokens * (ratio / 0.3)));
  compactIfNeeded(messages, { ...opts, budgetTokens: aggressiveBudget, force: true });

  const after = estimateMessages(messages);
  const recovered = after < before;
  return {
    recovered,
    before,
    after,
    reason: recovered ? "aggressive-forced-compaction" : "no-further-reduction",
  };
}
