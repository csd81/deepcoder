/**
 * Phase 10A — pure UI event model, config types, and status shape.
 *
 * This module defines the event boundary between the agent loop and terminal
 * rendering.  It has zero dependencies and is fully deterministic.
 */

// ── UiStatus ────────────────────────────────────────────────────────────────

export interface UiStatus {
  mode?: "ask" | "auto" | "readonly";
  model?: string;
  provider?: string;
  sandbox?: string;
  isolation?: string;
  branch?: string;
  dirty?: boolean;
  activeCheck?: string;
  tokens?: string;
}

// ── UiConfig ────────────────────────────────────────────────────────────────

export interface UiConfig {
  /** "plain" = line-mode (current default), "tui" = scrollable terminal UI. */
  mode: "plain" | "tui";
  /** Maximum total bytes the transcript may hold before evicting old blocks. */
  transcriptMaxBytes: number;
  /**
   * Tool/check output blocks whose body exceeds this threshold are collapsed
   * (head+tail slice retained).
   */
  collapseToolOutputAfterBytes: number;
  /** Whether to render a persistent status bar (TUI mode). */
  showStatusBar: boolean;
  /** Whether to use the alternate screen buffer (TUI mode). */
  useAlternateScreen: boolean;
}

export const DEFAULT_UI_CONFIG: UiConfig = {
  mode: "plain",
  transcriptMaxBytes: 8_388_608, // 8 MiB
  collapseToolOutputAfterBytes: 12_000,
  showStatusBar: true,
  useAlternateScreen: true,
};

// ── UiEvent ─────────────────────────────────────────────────────────────────

/**
 * Every event the agent loop can emit toward the UI layer.
 *
 * These are intentionally plain objects so they can be serialised, logged, or
 * replayed without ceremony.
 */
export type UiEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; text?: string }
  | { type: "tool_start"; name: string; description: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "notice"; message: string; severity?: "info" | "warn" | "error" }
  | { type: "approval_request"; id: string; description: string; diff?: string }
  | { type: "approval_result"; id: string; approved: boolean }
  | { type: "status"; patch: Partial<UiStatus> };
