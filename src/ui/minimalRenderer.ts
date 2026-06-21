/**
 * Phase 10A — minimal TUI renderer (pure frame builder + key mapping).
 *
 * This module is fully deterministic: no I/O, no ANSI escape codes, no
 * dependencies.  It builds the frame lines that a downstream I/O layer would
 * write to the terminal.
 */

// ── FrameInput ───────────────────────────────────────────────────────────────

export interface FrameInput {
  /** Text for the status bar (first line). */
  statusLine: string;
  /** All transcript lines (the full scrollable content). */
  lines: string[];
  /** Index into `lines` for the first visible row. */
  viewportTop: number;
  /** Number of rows available for the visible window (excluding status bar and input line). */
  height: number;
  /** Terminal width in columns — every output line is truncated to this. */
  width: number;
  /** Current input line text. */
  inputLine: string;
  /** Whether there is new output below the viewport (show indicator). */
  hasNewOutputBelow: boolean;
}

// ── renderFrame ──────────────────────────────────────────────────────────────

/**
 * Build the frame lines for the TUI.
 *
 * Returns an array of strings:
 *   [0]              — status bar (truncated to `width`)
 *   [1..height]      — visible window of `lines` sliced from `viewportTop`
 *   [maybe indicator] — "↓ new output below" line (only when `hasNewOutputBelow`)
 *   [last]           — input line (truncated to `width`)
 *
 * Every returned line is truncated to `width` columns.
 */
export function renderFrame(input: FrameInput): string[] {
  const { statusLine, lines, viewportTop, height, width, inputLine, hasNewOutputBelow } = input;
  const result: string[] = [];

  // 1. Status bar
  result.push(truncate(statusLine, width));

  // 2. Visible window
  const visible = lines.slice(viewportTop, viewportTop + height);
  for (const line of visible) {
    result.push(truncate(line, width));
  }

  // Pad remaining rows in the visible window if we have fewer lines than height
  const remainingRows = height - visible.length;
  for (let i = 0; i < remainingRows; i++) {
    result.push(truncate("", width));
  }

  // 3. "New output below" indicator
  if (hasNewOutputBelow) {
    result.push(truncate("↓ new output below", width));
  }

  // 4. Input line
  result.push(truncate(inputLine, width));

  return result;
}

// ── keyToAction ──────────────────────────────────────────────────────────────

export type KeyAction =
  | "scroll-up"
  | "scroll-down"
  | "half-up"
  | "half-down"
  | "top"
  | "bottom"
  | "escape"
  | "submit"
  | "interrupt"
  | "none";

/**
 * Map a key string to a semantic action.
 *
 * Accepts both readline-style key names (e.g. "pageup", "home") and raw
 * escape sequences where applicable.
 */
export function keyToAction(key: string): KeyAction {
  switch (key) {
    // PageUp / PageDown
    case "pageup":
    case "\u001b[5~":
      return "scroll-up";

    case "pagedown":
    case "\u001b[6~":
      return "scroll-down";

    // Ctrl+U / Ctrl+D (half-page)
    case "\u0015": // Ctrl+U
      return "half-up";

    case "\u0004": // Ctrl+D
      return "half-down";

    // Home / End
    case "home":
    case "\u001b[H":
    case "\u001b[1~":
      return "top";

    case "end":
    case "\u001b[F":
    case "\u001b[4~":
      return "bottom";

    // Escape
    case "escape":
    case "\u001b":
      return "escape";

    // Enter
    case "return":
    case "enter":
    case "\r":
    case "\n":
      return "submit";

    // Ctrl+C
    case "\u0003": // Ctrl+C
      return "interrupt";

    default:
      return "none";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate a string to at most `maxLen` columns.
 * If the string is shorter or equal, returns it unchanged.
 * This is a simple character-count truncation (no Unicode grapheme clusters).
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}
