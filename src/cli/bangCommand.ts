/**
 * Phase 10R — `!` shell-escape pure seams.
 *
 * `!ls` at the REPL/TUI prompt runs the line as a real shell command instead of
 * a model prompt. These pure helpers are the testable core; the I/O wiring (run
 * the command, render output, prompt to confirm) lives in repl.ts.
 */
import type { ApprovalMode } from "../config/config.js";

/**
 * Detect and strip a leading `!` shell-escape.
 *
 * - `"!ls"`/`"! ls"`/`"  !ls"` → `"ls"` (the gap right after `!` is dropped, but
 *   spacing inside the command is preserved).
 * - bare `"!"` (or `"!   "`) → `""` — a sentinel telling the caller to show a hint.
 * - anything not starting with `!` (after leading whitespace) → `null` (so slash
 *   commands and normal prompts are untouched).
 *
 * Must be consulted BEFORE slash/model dispatch so `!` never reaches the model.
 */
export function parseBangCommand(input: string): string | null {
  const s = input.replace(/^\s+/, "");
  if (!s.startsWith("!")) return null;
  return s.slice(1).replace(/^[ \t]+/, "");
}

export type BangDecision =
  | { action: "run" }
  | { action: "confirm"; reason: string }
  | { action: "refuse"; reason: string };

/**
 * Fail-closed policy for a user-typed `!command`:
 * - `readonly` mode → refuse (a shell-escape would break the no-mutation promise).
 * - classifier `deny` (rm -rf, sudo, subshells) → confirm (cheap guard vs fat-fingers).
 * - `allow`/`ask` → run directly (the human explicitly typed it; `ask` gates the
 *   model, not the operator).
 */
export function decideBang(
  command: string,
  mode: ApprovalMode,
  classify: (c: string) => "allow" | "ask" | "deny",
): BangDecision {
  if (mode === "readonly") {
    return { action: "refuse", reason: "shell-escape is disabled in --mode readonly" };
  }
  if (classify(command) === "deny") {
    return { action: "confirm", reason: "flagged dangerous by the command policy" };
  }
  return { action: "run" };
}
