/**
 * Phase 10A.17 — pure footer hints renderer for the modern TUI.
 *
 * Renders one compact line of contextual keyboard hints beneath the composer.
 * The hint line changes based on the current UI mode. Every hint is truncated
 * to the terminal width so narrow windows never overflow.
 */
import type { Theme } from "./theme.js";
import { truncate } from "./minimalRenderer.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type FooterHintMode =
  | "normal"
  | "busy"
  | "slash-menu"
  | "search"
  | "focused-block"
  | "approval";

export interface FooterHintInput {
  mode: FooterHintMode;
  width: number;
  theme: Theme;
}

// ── Hint strings ────────────────────────────────────────────────────────────

const HINTS: Record<FooterHintMode, string> = {
  normal:       "Enter send · / commands · Ctrl+F search · Tab blocks · ? help",
  busy:         "PgUp/PgDn scroll · Tab inspect · Ctrl+C interrupt · ? help",
  "slash-menu": "↑↓ select · Tab complete · Enter run · Esc close",
  search:       "Enter/n next · p previous · PgUp/PgDn scroll · Esc close",
  "focused-block": "Enter expand · y copy · s save · Tab next · Esc clear",
  approval:     "y approve · n deny · ↑↓ scroll · Esc deny",
};

// ── Renderer ────────────────────────────────────────────────────────────────

/**
 * Render the footer hints line for the given UI mode.
 *
 * The returned string is styled with the `theme.dim` style and truncated to
 * `width` visible columns.
 */
export function renderFooterHints(input: FooterHintInput): string {
  const raw = HINTS[input.mode];
  const styled = input.theme.dim(raw);
  return truncate(styled, input.width);
}
