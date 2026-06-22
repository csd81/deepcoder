/**
 * Phase 10A.14 — Pure types and renderers for structured slash-command results.
 *
 * Pure module: no I/O, no terminal, no process, no live model. Just data types
 * and deterministic renderers for plain-text and TUI output.
 */

import { redactSecrets } from "../workspace/redact.js";
import type { SlashOutcome } from "./slashCommands.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SlashResultKind =
  | "message"
  | "table"
  | "list"
  | "markdown"
  | "error";

export interface SlashResult {
  kind: SlashResultKind;
  title: string;
  body?: string;
  rows?: string[][];
  headers?: string[];
  severity?: "info" | "warn" | "error";
}

export interface StructuredSlashOutcome extends SlashOutcome {
  result?: SlashResult;
}

// ── Factory helpers ─────────────────────────────────────────────────────────

export function messageResult(
  title: string,
  body: string,
  severity?: "info" | "warn" | "error",
): SlashResult {
  return { kind: "message", title, body, severity };
}

export function tableResult(
  title: string,
  headers: string[],
  rows: string[][],
): SlashResult {
  return { kind: "table", title, headers, rows };
}

// ── Plain-text renderer ─────────────────────────────────────────────────────

/**
 * Render a SlashResult as a plain (non-TUI) string suitable for stdout.
 * All user-supplied text is redacted before rendering.
 */
export function renderSlashResultPlain(result: SlashResult): string {
  const lines: string[] = [];

  if (result.title) {
    lines.push(redactSecrets(result.title));
  }

  switch (result.kind) {
    case "message":
      if (result.body) {
        lines.push(redactSecrets(result.body));
      }
      break;

    case "table": {
      const headers = result.headers ?? [];
      const rows = result.rows ?? [];
      // Compute column widths from headers + rows (bounded)
      const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
      const widths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        let w = c < headers.length ? redactSecrets(headers[c]!).length : 0;
        for (const r of rows) {
          const cell = c < r.length ? redactSecrets(r[c]!).length : 0;
          if (cell > w) w = cell;
        }
        widths.push(w);
      }

      // Header row (if present)
      if (headers.length > 0) {
        const hRow = headers.map((h, i) => redactSecrets(h).padEnd(widths[i] ?? 0)).join("  ");
        lines.push(hRow);
        lines.push(widths.map((w) => "-".repeat(w)).join("  "));
      }

      // Data rows
      for (const r of rows) {
        const row = r.map((cell, i) => redactSecrets(cell).padEnd(widths[i] ?? 0)).join("  ");
        lines.push(row);
      }
      break;
    }

    case "list": {
      const items = result.rows ?? [];
      for (const item of items) {
        lines.push(`  ${redactSecrets(item.join(" · "))}`);
      }
      break;
    }

    case "markdown": {
      if (result.body) {
        lines.push(redactSecrets(result.body));
      }
      break;
    }

    case "error": {
      if (result.body) {
        lines.push(redactSecrets(result.body));
      }
      break;
    }
  }

  return lines.join("\n");
}

// ── TUI renderer ────────────────────────────────────────────────────────────

/**
 * Render a SlashResult as an array of lines suitable for a TUI block.
 * All user-supplied text is redacted before rendering.
 * Narrow widths are handled gracefully (no throw).
 */
export function renderSlashResultTui(
  result: SlashResult,
  opts: { width: number; theme: { dim: (s: string) => string; title: (s: string) => string; error: (s: string) => string; warning: (s: string) => string; success: (s: string) => string } },
): string[] {
  const { width, theme } = opts;
  const safeWidth = Math.max(8, width);
  const lines: string[] = [];

  // Title line
  const prefix = result.kind === "error" ? "▸" : "▾";
  const severityLabel = result.severity && result.severity !== "info"
    ? ` [${result.severity}]`
    : "";
  lines.push(`${prefix} ${theme.title(redactSecrets(result.title))}${severityLabel}`);

  switch (result.kind) {
    case "message":
      if (result.body) {
        const body = redactSecrets(result.body);
        lines.push(...wrapForTui(body, safeWidth, theme));
      }
      break;

    case "table": {
      const headers = result.headers ?? [];
      const rows = result.rows ?? [];
      const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
      // Compute column widths bounded by safeWidth
      const maxColW = Math.max(8, Math.floor(safeWidth / Math.max(1, colCount)));
      const widths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        let w = c < headers.length ? redactSecrets(headers[c]!).length : 0;
        for (const r of rows) {
          const cell = c < r.length ? redactSecrets(r[c]!).length : 0;
          if (cell > w) w = cell;
        }
        widths.push(Math.min(w, maxColW));
      }

      if (headers.length > 0) {
        const hRow = headers
          .map((h, i) => theme.title(redactSecrets(h).padEnd(widths[i] ?? 0)))
          .join("  ");
        lines.push(`  ${hRow}`);
        lines.push(`  ${widths.map((w) => theme.dim("-".repeat(w))).join("  ")}`);
      }

      for (const r of rows) {
        const row = r
          .map((cell, i) => redactSecrets(cell).padEnd(widths[i] ?? 0))
          .join("  ");
        lines.push(`  ${theme.dim(row)}`);
      }
      break;
    }

    case "list": {
      const items = result.rows ?? [];
      for (const item of items) {
        const line = item
          .map((p) => redactSecrets(p))
          .join(" · ");
        lines.push(`  ${theme.dim(line)}`);
      }
      break;
    }

    case "markdown": {
      if (result.body) {
        const body = redactSecrets(result.body);
        lines.push(...wrapForTui(body, safeWidth, theme));
      }
      break;
    }

    case "error": {
      if (result.body) {
        const body = redactSecrets(result.body);
        lines.push(...wrapForTui(body, safeWidth, { ...theme, dim: theme.error }));
      }
      break;
    }
  }

  return lines;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function wrapForTui(
  text: string,
  width: number,
  theme: { dim: (s: string) => string },
): string[] {
  if (!text) return [];
  const maxLine = Math.max(4, width - 2); // leaving 2-char indent
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    // Simple word-wrap
    let start = 0;
    while (start < paragraph.length) {
      let end = Math.min(start + maxLine, paragraph.length);
      if (end < paragraph.length && paragraph[end] !== " ") {
        const space = paragraph.lastIndexOf(" ", end);
        if (space > start) end = space;
      }
      const slice = paragraph.slice(start, end).trim();
      if (slice) lines.push(`  ${theme.dim(slice)}`);
      start = end;
    }
  }
  return lines;
}
