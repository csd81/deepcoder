/**
 * Phase 10A — pure UI mode resolver.
 *
 * Determines whether the session should use "plain" (line-mode) or "tui"
 * (scrollable terminal UI) based on TTY status, CLI flag, and environment
 * variables.  Fully deterministic — no I/O, no side effects.
 */

export interface ResolveUiModeInput {
  /** CLI flag value: "--tui" → "tui", "--no-tui" → "plain", absent → undefined */
  flag?: "tui" | "plain";
  /** Process environment (e.g. process.env) */
  env: Record<string, string | undefined>;
  /** Whether stdin is a TTY (the safety invariant gate) */
  isTTY: boolean;
}

/**
 * Resolve the UI mode from the given inputs.
 *
 * Safety invariant: if `isTTY` is false, the result is ALWAYS "plain",
 * regardless of flag or environment variables.
 *
 * Precedence when isTTY is true:
 *   1. `flag` (explicit CLI argument)
 *   2. `env.DEEPCODER_UI`
 *   3. `env.DEEPCODER_TUI`
 *   4. default → "plain"
 */
export function resolveUiMode(input: ResolveUiModeInput): "plain" | "tui" {
  // Safety invariant: non-TTY is always plain
  if (!input.isTTY) {
    return "plain";
  }

  // 1. Explicit CLI flag
  if (input.flag === "tui") return "tui";
  if (input.flag === "plain") return "plain";

  // 2. DEEPCODER_UI env var
  const uiEnv = input.env.DEEPCODER_UI;
  if (uiEnv === "tui") return "tui";
  if (uiEnv === "plain") return "plain";

  // 3. DEEPCODER_TUI env var (legacy)
  const tuiEnv = input.env.DEEPCODER_TUI;
  if (tuiEnv === "1") return "tui";
  if (tuiEnv === "0") return "plain";

  // 4. Default
  return "plain";
}
