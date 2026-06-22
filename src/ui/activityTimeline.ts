/**
 * Phase 10A.11 — Live Activity Timeline (pure module, no I/O).
 *
 * Derived state that summarises the latest/completed work into a compact
 * timeline for the live TUI view.  Fully deterministic: every timestamp is
 * injected by the caller.
 */

import type { UiEvent } from "./events.js";
import type { Theme } from "./theme.js";
import { redactSecrets } from "../workspace/redact.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ActivityKind =
  | "assistant"
  | "tool"
  | "check"
  | "worker"
  | "approval"
  | "notice";

export type ActivityStatus =
  | "running"
  | "passed"
  | "failed"
  | "done"
  | "waiting"
  | "info"
  | "warn"
  | "error";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  label: string;
  status: ActivityStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  /** @internal Stable lookup key for matching streaming updates. */
  refKey?: string;
}

export interface ActivityTimelineState {
  items: ActivityItem[];
  maxItems: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

let _nextItemId = 0;
/** Deterministic ID generator — resets on each process start. */
function nextItemId(): string {
  return `a${++_nextItemId}`;
}

/** Reset the ID counter (used in tests). */
export function _resetItemIds(): void {
  _nextItemId = 0;
}

/**
 * Build a stable ref-key from an event so streaming updates (e.g. tool_start
 * → tool_result, check_start → check_done) match the same timeline item.
 * Returns `undefined` for events that do not participate in matching (notice,
 * status).
 */
function refKeyFromEvent(kind: ActivityKind, event: UiEvent): string | undefined {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "tool":
      if (event.type === "tool_start" || event.type === "tool_result") return `tool:${event.name}`;
      return undefined;
    case "check":
      if (event.type === "check_start" || event.type === "check_output" || event.type === "check_done")
        return `check:${event.name}`;
      return undefined;
    case "worker":
      if (event.type === "worker_start" || event.type === "worker_update" || event.type === "worker_done")
        return `worker:${event.id}`;
      return undefined;
    case "approval":
      if (event.type === "approval_request" || event.type === "approval_result")
        return `approval:${event.id}`;
      return undefined;
    default:
      return undefined;
  }
}

// ── createActivityTimeline ─────────────────────────────────────────────────

export function createActivityTimeline(maxItems: number = 20): ActivityTimelineState {
  return { items: [], maxItems };
}

// ── applyActivityEvent ─────────────────────────────────────────────────────

/**
 * Apply a single UiEvent to the activity timeline, returning a **new** state
 * (immutable update).  `now` is an epoch-ms timestamp injected for determinism.
 */
export function applyActivityEvent(
  state: ActivityTimelineState,
  event: UiEvent,
  now: number = 0,
): ActivityTimelineState {
  switch (event.type) {
    // ── assistant ────────────────────────────────────────────────────────
    case "assistant_delta": {
      const ref = "assistant";
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      if (idx >= 0) {
        items[idx] = { ...items[idx], status: "running", startedAt: items[idx].startedAt ?? now };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "assistant",
          label: "thinking…",
          status: "running",
          refKey: ref,
          startedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    case "assistant_done": {
      const ref = "assistant";
      const idx = state.items.findIndex((it) => it.refKey === ref);
      if (idx < 0) return state;
      const items = [...state.items];
      items[idx] = { ...items[idx], status: "done", finishedAt: now };
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── tool ─────────────────────────────────────────────────────────────
    case "tool_start": {
      const ref = refKeyFromEvent("tool", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      const label = event.description ? `${event.name} ${event.description}` : event.name;
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          label,
          status: "running",
          detail: undefined,
          startedAt: items[idx].startedAt ?? now,
          finishedAt: undefined,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "tool",
          label,
          status: "running",
          refKey: ref,
          startedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    case "tool_result": {
      const ref = refKeyFromEvent("tool", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          status: event.isError ? "failed" : "done",
          detail: undefined,
          finishedAt: now,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "tool",
          label: event.name,
          status: event.isError ? "failed" : "done",
          refKey: ref,
          startedAt: now,
          finishedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── check ────────────────────────────────────────────────────────────
    case "check_start": {
      const ref = refKeyFromEvent("check", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      const label = event.name;
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          label,
          status: "running",
          detail: undefined,
          startedAt: items[idx].startedAt ?? now,
          finishedAt: undefined,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "check",
          label,
          status: "running",
          refKey: ref,
          startedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    case "check_output": {
      const ref = refKeyFromEvent("check", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      if (idx < 0) return state;
      const items = [...state.items];
      const lastLine = event.chunk.trim().split("\n").filter(Boolean).pop() ?? "";
      items[idx] = { ...items[idx], detail: lastLine.slice(0, 80) };
      return { ...state, items };
    }

    case "check_done": {
      const ref = refKeyFromEvent("check", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          status: event.passed ? "passed" : "failed",
          detail: undefined,
          finishedAt: now,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "check",
          label: event.name,
          status: event.passed ? "passed" : "failed",
          refKey: ref,
          startedAt: now,
          finishedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── worker ───────────────────────────────────────────────────────────
    case "worker_start": {
      const ref = refKeyFromEvent("worker", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      const label = `worker:${event.id}`;
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          label,
          status: "running",
          detail: undefined,
          startedAt: items[idx].startedAt ?? now,
          finishedAt: undefined,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "worker",
          label,
          status: "running",
          refKey: ref,
          startedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    case "worker_update": {
      const ref = refKeyFromEvent("worker", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      if (idx < 0) return state;
      const items = [...state.items];
      items[idx] = { ...items[idx], detail: event.status };
      return { ...state, items };
    }

    case "worker_done": {
      const ref = refKeyFromEvent("worker", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          status: "done",
          detail: event.summary,
          finishedAt: now,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "worker",
          label: `worker:${event.id}`,
          status: "done",
          detail: event.summary,
          refKey: ref,
          startedAt: now,
          finishedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── approval ─────────────────────────────────────────────────────────
    case "approval_request": {
      const ref = refKeyFromEvent("approval", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      const items = [...state.items];
      const label = event.description;
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          label,
          status: "waiting",
          startedAt: items[idx].startedAt ?? now,
          finishedAt: undefined,
        };
      } else {
        items.unshift({
          id: nextItemId(),
          kind: "approval",
          label,
          status: "waiting",
          refKey: ref,
          startedAt: now,
        });
      }
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    case "approval_result": {
      const ref = refKeyFromEvent("approval", event)!;
      const idx = state.items.findIndex((it) => it.refKey === ref);
      if (idx < 0) return state;
      const items = [...state.items];
      items[idx] = {
        ...items[idx],
        status: event.approved ? "passed" : "failed",
        finishedAt: now,
      };
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── notice ───────────────────────────────────────────────────────────
    case "notice": {
      const severity = event.severity ?? "info";
      const statusMap: Record<string, ActivityStatus> = {
        info: "info",
        warn: "warn",
        error: "error",
      };
      const items = [...state.items];
      items.unshift({
        id: nextItemId(),
        kind: "notice",
        label: event.message,
        status: statusMap[severity] ?? "info",
        startedAt: now,
      });
      return { ...state, items: trimItems(items, state.maxItems) };
    }

    // ── status (ignored — not timeline-relevant) ─────────────────────────
    case "status":
      return state;
  }
}

/** Trim items array to at most `maxItems`, keeping newest first. */
function trimItems(items: ActivityItem[], maxItems: number): ActivityItem[] {
  if (items.length <= maxItems) return items;
  return items.slice(0, maxItems);
}

// ── renderActivityTimeline ────────────────────────────────────────────────

/** Symbol (or short string) for each status. */
function statusSymbol(status: ActivityStatus): string {
  switch (status) {
    case "running": return "●";
    case "passed":  return "✓";
    case "done":    return "✓";
    case "failed":  return "✗";
    case "error":   return "✗";
    case "waiting": return "?";
    case "info":    return "i";
    case "warn":    return "!";
  }
}

/** Pick a theme style function for the status. */
function statusStyle(status: ActivityStatus, theme: Theme): (s: string) => string {
  switch (status) {
    case "running": return theme.warning;
    case "passed":  return theme.success;
    case "done":    return theme.success;
    case "failed":  return theme.error;
    case "error":   return theme.error;
    case "waiting": return theme.warning;
    case "info":    return theme.dim;
    case "warn":    return theme.warning;
  }
}

/** Truncate a string so that its visible length ≤ maxLen. */
function truncateLine(line: string, maxLen: number): string {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= maxLen) return line;
  return plain.slice(0, maxLen);
}

export interface RenderActivityTimelineOpts {
  /** Terminal width in columns. */
  width: number;
  /** Max rows to render (default 5). */
  maxRows?: number;
  /** Theme for coloring. */
  theme?: Theme;
  /** Epoch-ms timestamp — reserved for future duration display. */
  now?: number;
}

/**
 * Render the activity timeline as an array of lines (newest first).
 *
 * Returns an empty array when there are no items to show.  Each line is
 * bounded to `width`.
 */
export function renderActivityTimeline(
  state: ActivityTimelineState,
  opts: RenderActivityTimelineOpts,
): string[] {
  const { width, maxRows = 5, theme } = opts;

  // Collect items that are still relevant: running/waiting always shown,
  // plus the most recent completed items
  const running = state.items.filter(
    (it) => it.status === "running" || it.status === "waiting",
  );
  const done = state.items.filter(
    (it) =>
      it.status === "passed" ||
      it.status === "done" ||
      it.status === "failed" ||
      it.status === "error" ||
      it.status === "info" ||
      it.status === "warn",
  );

  // Show: running items first (newest), then completed items (newest)
  const candidates = [...running, ...done];
  const visible = candidates.slice(0, maxRows);

  if (visible.length === 0) return [];

  const t: Theme = theme ?? {
    dim: (s: string) => s,
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    title: (s: string) => s,
    selected: (s: string) => s,
  };

  const lines: string[] = [];
  for (const item of visible) {
    const sym = statusSymbol(item.status);
    const style = statusStyle(item.status, t);

    // Build the text part: "● label" or "● label  detail"
    let text = `${sym} ${item.label}`;
    if (item.detail) {
      const redacted = redactSecrets(item.detail);
      text += ` ${t.dim(redacted)}`;
    }

    const styled = style(text);
    lines.push(truncateLine(styled, width));
  }

  return lines;
}
