/**
 * Phase 10A.19 — Style Tokens
 *
 * Cohesive semantic style system that wraps the existing Theme. Provides role
 * styling (user/assistant/system/tool/check/worker), state styling
 * (success/error/warning/running/muted/selected), and chrome symbols for the
 * transcript presenter, status bar, and help overlay.
 *
 * Pure module: no I/O, no ANSI generation of its own — delegates to the Theme
 * which is already gated by the color-enabled flag.
 */

import type { Theme } from "./theme.js";

// ── StyleTokens ──────────────────────────────────────────────────────────────

export interface StyleTokens {
  role: {
    user: (s: string) => string;
    assistant: (s: string) => string;
    system: (s: string) => string;
    tool: (s: string) => string;
    check: (s: string) => string;
    worker: (s: string) => string;
  };
  state: {
    success: (s: string) => string;
    error: (s: string) => string;
    warning: (s: string) => string;
    running: (s: string) => string;
    muted: (s: string) => string;
    selected: (s: string) => string;
  };
  chrome: {
    separator: string;
    bulletCollapsed: string;
    bulletExpanded: string;
    checkPass: string;
    checkFail: string;
  };
}

// ── createStyleTokens ────────────────────────────────────────────────────────

/**
 * Build a StyleTokens instance from the given Theme.
 *
 * Conventions:
 *  - user / assistant  → bold title style (visually primary)
 *  - system / tool / check / worker → dim style (secondary)
 *  - success → green, error → red, warning → yellow
 *  - running → bold, muted → dim, selected → inverted
 *  - Chrome symbols use plain Unicode — no SGR applied at this level.
 */
export function createStyleTokens(theme: Theme): StyleTokens {
  return {
    role: {
      user: (s) => theme.title(s),
      assistant: (s) => theme.title(s),
      system: (s) => theme.dim(s),
      tool: (s) => theme.dim(s),
      check: (s) => theme.dim(s),
      worker: (s) => theme.dim(s),
    },
    state: {
      success: (s) => theme.success(s),
      error: (s) => theme.error(s),
      warning: (s) => theme.warning(s),
      running: (s) => theme.title(s),
      muted: (s) => theme.dim(s),
      selected: (s) => theme.selected(s),
    },
    chrome: {
      separator: "─",
      bulletCollapsed: "▸",
      bulletExpanded: "▾",
      checkPass: "✓",
      checkFail: "✗",
    },
  };
}
