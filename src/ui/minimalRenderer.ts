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
  /** Current input line text (single-line composer). */
  inputLine: string;
  /** Multiline composer rows; when present, used instead of `inputLine`. */
  inputLines?: string[];
  /** Whether there is new output below the viewport (show indicator). */
  hasNewOutputBelow: boolean;
  /** Slash-command dropdown rows, rendered just above the composer when open. */
  menuLines?: string[];
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

  // 4. Slash-command dropdown (above the composer, when open)
  if (input.menuLines) {
    for (const row of input.menuLines) result.push(truncate(row, width));
  }

  // 5. Input composer (one or more rows)
  const composer = input.inputLines ?? [inputLine];
  for (const row of composer) result.push(truncate(row, width));

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
  | "history-up"
  | "history-down"
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

    // Up / Down — prompt history navigation
    case "up":
      return "history-up";

    case "down":
      return "history-down";

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

/** SGR (color) escape sequence matcher — these are zero-width on screen. */
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Visible column count of a string, ignoring SGR color codes (which take no
 * screen space). Still a simple per-codepoint count (no grapheme/CJK awareness).
 */
export function visibleWidth(s: string): number {
  return s.replace(SGR, "").length;
}

/**
 * Truncate a string to at most `maxLen` VISIBLE columns, preserving any SGR
 * color codes and appending a reset if the string was cut while styled. Lines
 * that already fit (by visible width) are returned unchanged.
 */
export function truncate(s: string, maxLen: number): string {
  if (visibleWidth(s) <= maxLen) return s;
  let out = "";
  let count = 0;
  let i = 0;
  let sawEscape = false;
  while (i < s.length && count < maxLen) {
    const rest = s.slice(i);
    const m = /^\x1b\[[0-9;]*m/.exec(rest);
    if (m) {
      out += m[0];
      i += m[0].length;
      sawEscape = true;
      continue;
    }
    out += s[i];
    i += 1;
    count += 1;
  }
  return sawEscape ? out + "\x1b[0m" : out;
}
