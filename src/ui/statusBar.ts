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
  /** Human-readable session title, set via /title or --title. */
  title?: string;
  /** Side conversation active indicator. */
  side?: boolean;
}

export type StatuslineField =
  | "mode"
  | "model"
  | "sandbox"
  | "web"
  | "branch"
  | "tokens"
  | "cost"
  | "workers"
  | "busy"
  | "session"
  | "title"
  | "side";

export const DEFAULT_STATUSBAR_FIELDS: StatuslineField[] = [
  "title", "mode", "model", "sandbox", "web",
  "branch", "tokens", "cost", "workers", "busy",
];

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

/**
 * Render a single statusline field. Returns a styled string, or null when the
 * field's data is absent / not applicable (the segment is then skipped entirely).
 */
export function renderField(field: StatuslineField, info: StatusBarInfo, theme: Theme): string | null {
  switch (field) {
    case "title":   return theme.title(info.title ?? "deepcoder");
    case "mode":    return info.mode === "yolo" ? theme.warning("YOLO") : theme.dim(info.mode);
    case "model":   return theme.dim(`${info.provider}/${info.model}`);
    case "sandbox": return theme.dim(`sandbox ${info.sandbox}`);
    case "web":     return theme.dim(`web ${info.web ? "on" : "off"}`);
    case "branch":  return info.branch ? theme.dim(`${info.branch}${info.dirty ? "*" : ""}`) : null;
    case "tokens":  return (typeof info.tokens === "number" && Number.isFinite(info.tokens)) ? theme.dim(formatTokens(info.tokens)) : null;
    case "cost":    return (typeof info.costUsd === "number" && Number.isFinite(info.costUsd)) ? theme.dim(`$${info.costUsd.toFixed(2)}`) : null;
    case "workers": return (typeof info.workers === "number" && info.workers > 0) ? theme.dim(`${info.workers} workers`) : null;
    case "busy":    return info.busy ? theme.warning("running") : theme.dim("idle");
    case "session": return null; // sessionId not yet on StatusBarInfo
    case "side":    return info.side ? theme.warning("side") : null;
    default:        return null;
  }
}

export function renderStatusBar(
  info: StatusBarInfo,
  width: number,
  theme: Theme,
  fields?: StatuslineField[],
): string {
  const order = fields ?? DEFAULT_STATUSBAR_FIELDS;
  const segs: string[] = [];

  for (const field of order) {
    const s = renderField(field, info, theme);
    if (s !== null) segs.push(s);
  }

  return truncate(segs.join(theme.dim(" · ")), width);
}
