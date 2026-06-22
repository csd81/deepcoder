/**
 * Phase 10A7 — pure slash command dropdown (state + render).
 *
 * Navigation/metadata only: this module decides what the dropdown shows and how
 * it looks. It NEVER executes a command — `handleSlashCommand` is the executor.
 *
 * Pure: no terminal I/O, no process/stdin/stdout, no file reads. `renderSlashMenu`
 * returns bounded string[] (each line's visibleWidth <= width) and degrades to
 * ASCII when the theme has no color (box-drawing dropped to plain characters).
 */
import { SLASH_CATALOG, filterSlashCommands, type SlashCommandInfo } from "../cli/slashCatalog.js";
import { visibleWidth } from "./minimalRenderer.js";
import type { Theme } from "./theme.js";

export interface SlashMenuState {
  open: boolean;
  query: string;
  matches: SlashCommandInfo[];
  selected: number;
}

const DEFAULT_MAX_VISIBLE = 8;

/** A closed, empty menu. */
export function initSlashMenu(): SlashMenuState {
  return { open: false, query: "", matches: [], selected: 0 };
}

/** The token after the leading `/` (whitespace ends the token). */
function tokenFor(inputText: string): string {
  // inputText starts with "/"; take everything up to the first whitespace.
  const body = inputText.slice(1);
  const sp = body.search(/\s/);
  return sp === -1 ? body : body.slice(0, sp);
}

/**
 * Recompute the menu from the current composer text. The menu is open only when
 * the input starts with `/` AND has no whitespace yet (i.e. the user is still
 * typing the command token, not its arguments). Matches are filtered by the
 * current token and capped to `maxVisible`. The selection is clamped into range.
 */
export function updateSlashMenu(
  state: SlashMenuState,
  inputText: string,
  maxVisible: number = DEFAULT_MAX_VISIBLE,
): SlashMenuState {
  const startsWithSlash = inputText.startsWith("/");
  const hasWhitespace = /\s/.test(inputText);
  if (!startsWithSlash || hasWhitespace) {
    return { open: false, query: "", matches: [], selected: 0 };
  }
  const token = tokenFor(inputText);
  const cap = Math.max(1, maxVisible);
  const matches = filterSlashCommands(SLASH_CATALOG, token).slice(0, cap);
  const selected = matches.length === 0 ? 0 : Math.min(state.selected, matches.length - 1);
  return { open: matches.length > 0, query: token, matches, selected };
}

/** Move the selection by `delta`, clamped to [0, matches.length - 1]. */
export function moveSelection(state: SlashMenuState, delta: number): SlashMenuState {
  if (!state.open || state.matches.length === 0) return state;
  const max = state.matches.length - 1;
  const selected = Math.min(max, Math.max(0, state.selected + delta));
  return { ...state, selected };
}

/** Close the menu (e.g. on Esc), preserving nothing visible. */
export function closeSlashMenu(state: SlashMenuState): SlashMenuState {
  return { ...state, open: false, matches: [], selected: 0 };
}

/**
 * The completed command text for the selected match, e.g. `/check `. Returns
 * null when the menu is closed or has no selection. A trailing space is included
 * so the user can immediately type arguments.
 */
export function completeSelected(state: SlashMenuState): string | null {
  if (!state.open || state.matches.length === 0) return null;
  const cmd = state.matches[state.selected];
  if (!cmd) return null;
  return `/${cmd.name} `;
}

const MIN_WIDTH = 4;

/**
 * Render the menu to bounded string[]. Every returned line has
 * visibleWidth <= `width`. When `theme` produces no color (createTheme(false)),
 * the output contains no SGR escape codes and box-drawing is replaced by ASCII.
 */
export function renderSlashMenu(state: SlashMenuState, width: number, theme: Theme): string[] {
  if (!state.open || state.matches.length === 0) return [];
  const colored = themeHasColor(theme);
  const w = Math.max(MIN_WIDTH, Math.floor(width));
  const inner = w - 2; // account for left+right border columns

  const tl = colored ? "╭" : "+";
  const tr = colored ? "╮" : "+";
  const bl = colored ? "╰" : "+";
  const br = colored ? "╯" : "+";
  const h = colored ? "─" : "-";
  const v = colored ? "│" : "|";

  const lines: string[] = [];

  // Header: "<corner> commands <fill> <corner>"
  const headerLabel = " commands ";
  const headerFill = Math.max(0, inner - headerLabel.length);
  lines.push(tl + clampVisible(headerLabel + h.repeat(headerFill), inner) + tr);

  for (let i = 0; i < state.matches.length; i++) {
    const cmd = state.matches[i]!;
    const left = cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
    // Reserve room for a 2-space gap before the description.
    const cell = padOrTruncate(`${left}  ${cmd.description}`, inner - 2);
    const styled = i === state.selected ? theme.selected(cell) : theme.dim(cell);
    lines.push(v + " " + styled + " " + v);
  }

  lines.push(bl + h.repeat(Math.max(0, inner)) + br);

  // Final safety: hard-bound every line to `width` visible columns.
  return lines.map((l) => clampVisible(l, w));
}

/** Pad to exactly `target` visible columns, or truncate (no SGR inside). */
function padOrTruncate(s: string, target: number): string {
  const t = Math.max(0, target);
  const vw = visibleWidth(s);
  if (vw === t) return s;
  if (vw < t) return s + " ".repeat(t - vw);
  return clampVisible(s, t);
}

/** Truncate a (plain, no-SGR) string to at most `maxLen` visible columns. */
function clampVisible(s: string, maxLen: number): string {
  if (visibleWidth(s) <= maxLen) return s;
  // Lines built here contain SGR only via the outer theme.selected wrapper, which
  // is applied to already-sized cells; the corner/border lines are plain. Strip
  // by codepoint count on the visible portion.
  let out = "";
  let count = 0;
  let i = 0;
  while (i < s.length && count < maxLen) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    i += 1;
    count += 1;
  }
  return out;
}

/** Detect whether the theme emits SGR codes (color on) by probing one style. */
function themeHasColor(theme: Theme): boolean {
  return theme.selected("x") !== "x";
}
