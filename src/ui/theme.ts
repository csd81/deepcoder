/**
 * Phase 10A full TUI — color & theming (pure, no I/O, no deps).
 *
 * Hand-rolled SGR codes (rather than chalk) so the decision is deterministic and
 * testable, independent of any library's own env detection. A single resolved
 * `color` boolean gates everything; when off, every style is the identity
 * function so no escape codes ever reach a non-color terminal.
 */

import { createNamedTheme } from "./themes.js";

export interface ColorResolveInput {
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

/**
 * Decide whether to emit ANSI color. Precedence:
 *   1. FORCE_COLOR set      -> "0"/"false" disables, anything else enables
 *   2. NO_COLOR present     -> disable (regardless of value; see no-color.org)
 *   3. otherwise            -> follow the TTY
 */
export function resolveColorEnabled(input: ColorResolveInput): boolean {
  const force = input.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  if (input.env.NO_COLOR !== undefined) return false;
  return input.isTTY;
}

export interface Theme {
  dim: (s: string) => string;
  success: (s: string) => string;
  error: (s: string) => string;
  warning: (s: string) => string;
  title: (s: string) => string;
  selected: (s: string) => string;
}

/**
 * Build the default theme. Delegates to the named `"default"` palette in
 * themes.ts so there is a single source of truth for the default colors (the
 * darker + bolder, pale-background-legible palette). When `color` is false,
 * every style is the identity function.
 */
export function createTheme(color: boolean): Theme {
  return createNamedTheme("default", color);
}
