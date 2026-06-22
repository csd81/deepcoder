/**
 * Phase 10A.7 — pure status bar renderer for the modern TUI.
 *
 * Renders one compact line of operational state. Every optional segment is
 * dropped entirely when its data is absent, so a minimal session never shows
 * `undefined`/`NaN` or dangling separators. The shell assembles {@link StatusBarInfo}
 * each frame and the result is truncated to the terminal width.
 */
import type { Theme } from "./theme.js";
import { truncate } from "./minimalRenderer.js";

export interface StatusBarInfo {
  /** Approval mode (ask/auto/...). */
  mode: string;
  provider: string;
  model: string;
  /** Sandbox mode label. */
  sandbox: string;
  /** Web tools enabled this session. */
  web: boolean;
  /** Current git branch, when cheaply known. */
  branch?: string;
  /** Working tree dirty — adds a `*` to the branch. */
  dirty?: boolean;
  /** Cumulative context tokens, when known. */
  tokens?: number;
  /** Session cost in USD, when known. */
  costUsd?: number;
  /** Running delegate workers, when any. */
  workers?: number;
  /** A task/turn is in flight. */
  busy: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

export function renderStatusBar(info: StatusBarInfo, width: number, theme: Theme): string {
  // Each entry is a styled segment; falsy entries are skipped so there are never
  // empty " ·  · " gaps.
  const segs: string[] = [];
  segs.push(theme.title("deepcoder"));
  segs.push(theme.dim(info.mode));
  segs.push(theme.dim(`${info.provider}/${info.model}`));
  segs.push(theme.dim(`sandbox ${info.sandbox}`));
  segs.push(theme.dim(`web ${info.web ? "on" : "off"}`));
  if (info.branch) segs.push(theme.dim(`${info.branch}${info.dirty ? "*" : ""}`));
  if (typeof info.tokens === "number" && Number.isFinite(info.tokens)) segs.push(theme.dim(formatTokens(info.tokens)));
  if (typeof info.costUsd === "number" && Number.isFinite(info.costUsd)) segs.push(theme.dim(`$${info.costUsd.toFixed(2)}`));
  if (typeof info.workers === "number" && info.workers > 0) segs.push(theme.dim(`${info.workers} workers`));
  segs.push(info.busy ? theme.warning("running") : theme.dim("idle"));
  return truncate(segs.join(theme.dim(" · ")), width);
}
