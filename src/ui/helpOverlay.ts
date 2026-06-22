/**
 * Phase 10A.13 — contextual TUI help overlay (pure, no I/O).
 *
 * Provides mode-specific keybinding entries and a bounded box renderer suitable
 * for overlaying the transcript area. All logic is deterministic and testable
 * without a terminal.
 */
import type { Theme } from "./theme.js";
import { truncate } from "./minimalRenderer.js";

// ── Types ────────────────────────────────────────────────────────────────

export type HelpMode =
  | "normal"
  | "busy"
  | "focused-block"
  | "slash-menu"
  | "search"
  | "approval";

export interface HelpEntry {
  keys: string;
  label: string;
  detail?: string;
}

export interface HelpOverlayInput {
  mode: HelpMode;
  width: number;
  height: number;
  color?: boolean;
  title?: string;
}

// ── Mode → entries ───────────────────────────────────────────────────────

const ENTRIES: Record<HelpMode, HelpEntry[]> = {
  normal: [
    { keys: "Enter", label: "submit prompt" },
    { keys: "Alt+Enter", label: "insert newline" },
    { keys: "\u2191/\u2193", label: "prompt history" },
    { keys: "PgUp/PgDn", label: "scroll transcript" },
    { keys: "Home/End", label: "top/bottom" },
    { keys: "/", label: "slash commands" },
    { keys: "Ctrl+F", label: "search transcript" },
    { keys: "Tab", label: "focus next tool/check/worker block" },
    { keys: "?", label: "help" },
    { keys: "Ctrl+C", label: "exit / interrupt" },
  ],
  "focused-block": [
    { keys: "Tab", label: "next block" },
    { keys: "Shift+Tab", label: "previous block" },
    { keys: "Enter", label: "expand/collapse" },
    { keys: "Esc", label: "clear focus" },
    { keys: "y", label: "copy block" },
    { keys: "s", label: "save block" },
  ],
  "slash-menu": [
    { keys: "\u2191/\u2193", label: "select command" },
    { keys: "Tab", label: "complete command" },
    { keys: "Enter", label: "submit command" },
    { keys: "Esc", label: "close menu" },
  ],
  search: [
    { keys: "type", label: "update search" },
    { keys: "Enter / n", label: "next match" },
    { keys: "p", label: "previous match" },
    { keys: "PgUp/PgDn", label: "scroll" },
    { keys: "Esc", label: "close search" },
  ],
  approval: [
    { keys: "y", label: "approve" },
    { keys: "n", label: "deny" },
    { keys: "\u2191/\u2193", label: "scroll diff" },
    { keys: "PgUp/PgDn", label: "scroll diff faster" },
    { keys: "Esc", label: "deny / close" },
  ],
  busy: [
    { keys: "PgUp/PgDn", label: "scroll while work runs" },
    { keys: "Tab", label: "inspect latest block" },
    { keys: "Ctrl+C", label: "interrupt" },
    { keys: "?", label: "help" },
  ],
};

export function helpEntriesForMode(mode: HelpMode): HelpEntry[] {
  return ENTRIES[mode];
}

// ── Render ───────────────────────────────────────────────────────────────

function hasColor(theme: Theme): boolean {
  return theme.selected("x") !== "x";
}

export function renderHelpOverlay(input: HelpOverlayInput, theme: Theme): string[] {
  const w = input.width < 10 ? 10 : Math.floor(input.width);
  const h = input.height < 2 ? 2 : Math.floor(input.height);
  const colored = hasColor(theme);
  const entries = ENTRIES[input.mode];
  const inner = w - 2;

  const TL = colored ? "\u256D" : "+";
  const TR = colored ? "\u256E" : "+";
  const BL = colored ? "\u2570" : "+";
  const BR = colored ? "\u256F" : "+";
  const HC = colored ? "\u2500" : "-";
  const VE = colored ? "\u2502" : "|";

  const rows: string[] = [];

  // Title
  const title = input.title ?? (" Help \u2014 " + input.mode + " ");
  rows.push(TL + theme.title(title.slice(0, inner).padEnd(inner, HC)) + TR);

  // Entries
  const maxKey = Math.max(4, ...entries.map((e) => e.keys.length));
  const keyW = Math.min(maxKey, Math.max(4, inner - 4));

  for (const e of entries) {
    const key = e.keys.padEnd(keyW, " ").slice(0, keyW);
    const label = e.label.slice(0, Math.max(1, inner - keyW - 3));
    const pad = Math.max(0, inner - 3 - keyW - label.length);
    rows.push(VE + " " + key + "  " + label + " ".repeat(pad) + VE);
  }

  // Footer
  const foot = " Esc close ";
  rows.push(BL + foot.slice(0, inner).padEnd(inner, HC) + BR);

  // Cap to height: title + (entries) + footer
  const maxBody = Math.max(0, h - 2);
  const out: string[] = [rows[0]];
  for (let i = 1; i < rows.length - 1 && out.length - 1 < maxBody; i++) {
    out.push(rows[i]);
  }
  out.push(rows[rows.length - 1]);

  // Cap to the ACTUAL requested height (h has a min of 2 for a usable box, but
  // the caller may give 1 — never emit more rows than were asked for).
  const cap = Math.max(0, Math.floor(input.height));
  return out.slice(0, cap).map((l) => truncate(l, w));
}
