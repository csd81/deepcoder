import type { ApprovalDecision } from "./policy.js";
import { parseShellProgram } from "./shellAst.js";
import { buildCommandMatrix, classifyMatrix } from "./commandMatrix.js";

/**
 * Classify a raw bash command into a default permission decision.
 *
 * Phase 7F: this is now a thin wrapper over a shell-aware pipeline:
 *
 *   raw command
 *     -> parseShellProgram      (shellAst.ts: structural tokenizer/parser)
 *     -> buildCommandMatrix     (commandMatrix.ts: segments + hazards)
 *     -> classifyMatrix         (commandMatrix.ts: allow / ask / deny)
 *
 * The classifier is an auto-approval gate, not a sandbox. It fails closed:
 * parse failure / unsupported syntax / parser crash → "ask" (never "allow"),
 * and constructs that execute nested commands → "deny".
 *
 * The public contract is unchanged: `classifyCommand(command) => ApprovalDecision`.
 */
export function classifyCommand(command: string): ApprovalDecision {
  const parsed = parseShellProgram(command);
  if (!parsed.ok) {
    // empty / parse_error / unsupported → fail closed to "ask" (never "allow").
    return "ask";
  }
  return classifyMatrix(buildCommandMatrix(parsed.program));
}
