/**
 * Phase 10A.7 — pure chat-UI state for the modern terminal TUI.
 *
 * Owns the transitions that runTuiRepl previously did inline: viewport scroll
 * (and whether the view is pinned to the bottom), the slash-command menu, the
 * focused region, and the terminal size. The shell folds keystrokes and mouse
 * wheel events into {@link ChatUiAction}s and renders from the returned state;
 * it never mutates these fields directly. Keeping this pure makes scroll/menu
 * behavior unit-testable without a real TTY.
 *
 * `maxTop` (the largest valid `viewportTop` for the current content/height) is
 * computed by the shell from the wrapped line count and passed in per action —
 * this module deliberately knows nothing about rendering or wrapping.
 */
import {
  initSlashMenu,
  updateSlashMenu,
  moveSelection,
  closeSlashMenu,
  type SlashMenuState,
} from "./slashMenu.js";

export type ChatRegion = "transcript" | "composer" | "slash-menu" | "approval";

export interface ChatUiState {
  viewportTop: number;
  atBottom: boolean;
  slashMenu: SlashMenuState;
  focusedRegion: ChatRegion;
  size: { width: number; height: number };
}

export type ChatUiAction =
  | { type: "scroll-up"; amount?: number }
  | { type: "scroll-down"; amount?: number }
  | { type: "scroll-top" }
  | { type: "scroll-bottom" }
  | { type: "resize"; width: number; height: number }
  | { type: "input-changed"; text: string; maxVisible?: number }
  | { type: "menu-up" }
  | { type: "menu-down" }
  | { type: "menu-close" }
  | { type: "submit" };

/** Per-action context the shell supplies (content-dependent, so not in state). */
export interface ChatUiCtx {
  /** Largest valid viewportTop for the current content + window height (>= 0). */
  maxTop: number;
}

export function initChatUi(size: { width: number; height: number }): ChatUiState {
  return {
    viewportTop: 0,
    atBottom: true,
    slashMenu: initSlashMenu(),
    focusedRegion: "composer",
    size: { ...size },
  };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function reduceChatUi(state: ChatUiState, action: ChatUiAction, ctx: ChatUiCtx): ChatUiState {
  const maxTop = Math.max(0, ctx.maxTop);
  switch (action.type) {
    case "scroll-up": {
      const top = clamp(state.viewportTop - Math.max(1, action.amount ?? 1), 0, maxTop);
      return { ...state, viewportTop: top, atBottom: false, focusedRegion: "transcript" };
    }
    case "scroll-down": {
      const top = clamp(state.viewportTop + Math.max(1, action.amount ?? 1), 0, maxTop);
      return { ...state, viewportTop: top, atBottom: top >= maxTop, focusedRegion: top >= maxTop ? state.focusedRegion : "transcript" };
    }
    case "scroll-top":
      return { ...state, viewportTop: 0, atBottom: false, focusedRegion: "transcript" };
    case "scroll-bottom":
      return { ...state, viewportTop: maxTop, atBottom: true };
    case "resize": {
      const size = { width: action.width, height: action.height };
      const top = state.atBottom ? maxTop : clamp(state.viewportTop, 0, maxTop);
      return { ...state, size, viewportTop: top };
    }
    case "input-changed": {
      const slashMenu = updateSlashMenu(state.slashMenu, action.text, action.maxVisible);
      return { ...state, slashMenu, focusedRegion: slashMenu.open ? "slash-menu" : "composer" };
    }
    case "menu-up":
      return state.slashMenu.open ? { ...state, slashMenu: moveSelection(state.slashMenu, -1) } : state;
    case "menu-down":
      return state.slashMenu.open ? { ...state, slashMenu: moveSelection(state.slashMenu, 1) } : state;
    case "menu-close":
      return { ...state, slashMenu: closeSlashMenu(state.slashMenu) };
    case "submit":
      return { ...state, slashMenu: closeSlashMenu(state.slashMenu), viewportTop: maxTop, atBottom: true, focusedRegion: "composer" };
    default:
      return state;
  }
}
