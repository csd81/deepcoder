/**
 * Phase 10B — Dynamic table renderer (pure, no I/O).
 *
 * Produces a string[] of formatted table lines with Unicode box-drawing
 * characters (┌ ─ ┐ │ └ ┘ ├ ┤ ┼ ┬ ┴) by default, or ASCII (+ - |) on
 * request. Column widths auto-size from content, capped by maxWidth and
 * floored by minWidth.  When availableWidth is given, the widest columns
 * are shrunk (respecting minWidth) to fit.
 */

import { visibleWidth, truncate } from "./minimalRenderer.js";

// ── Exports ───────────────────────────────────────────────────────────────────

export interface Column {
  header: string;
  align?: "left" | "right";
  maxWidth?: number;
  minWidth?: number;
}

export interface TableOptions {
  /** Use box-drawing chars (default) or plain ASCII. */
  style?: "unicode" | "ascii";
  /** Total available width. When absent, no wrapping. */
  availableWidth?: number;
  /** Padding per cell, default 1. */
  padding?: number;
}

/**
 * Render a table as an array of formatted lines.
 *
 * @param columns  Column definitions (header, alignment, width hints).
 * @param rows     Data rows, each an array of cell strings matching columns.
 * @param opts     Optional rendering options (style, availableWidth, padding).
 * @returns        Lines ready to join with "\n" or print directly.
 */
export function renderTable(
  columns: Column[],
  rows: string[][],
  opts?: TableOptions,
): string[] {
  const style = opts?.style ?? "unicode";
  const pad = opts?.padding ?? 1;
  const avail = opts?.availableWidth;

  // 1. Calculate column widths: auto from max content, capped by maxWidth,
  //    floored by minWidth
  const widths = columns.map((col, i) => {
    const contentWidths = rows.map((r) => visibleWidth(r[i] ?? ""));
    const maxContent = Math.max(visibleWidth(col.header), ...contentWidths);
    const clamped = Math.min(maxContent, col.maxWidth ?? Infinity);
    return Math.max(clamped, col.minWidth ?? 0);
  });

  // 2. If total exceeds available width, shrink widest columns
  //    proportionally (respecting minWidth)
  if (avail !== undefined) {
    fitToWidth(widths, columns, avail, pad);
  }

  // 3. Build separator, header, separator, rows, separator
  const out: string[] = [];

  out.push(renderSep(widths, pad, style, "top"));
  out.push(renderRow(columns.map((c) => c.header), widths, pad, style));
  if (rows.length > 0) {
    out.push(renderSep(widths, pad, style, "mid"));
    for (const row of rows) {
      out.push(renderRow(row, widths, pad, style));
    }
  }

  out.push(renderSep(widths, pad, style, "bot"));
  return out;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function renderRow(
  cells: string[],
  widths: number[],
  pad: number,
  style: TableOptions["style"],
): string {
  const sep = style === "ascii" ? "|" : "│";
  const parts = cells.map((c, i) => {
    const w = widths[i]!;
    const vis = visibleWidth(c);
    // Truncate if wider than the column; otherwise right-pad in display columns
    // (CJK/emoji count as two), so the box borders line up.
    const text = vis > w ? truncateToWidth(c, w) : c + " ".repeat(w - vis);
    return " ".repeat(pad) + text + " ".repeat(pad);
  });
  return `${sep}${parts.join(sep)}${sep}`;
}

function renderSep(
  widths: number[],
  pad: number,
  style: TableOptions["style"],
  pos: "top" | "mid" | "bot",
): string {
  const [left, fill, right, cross] =
    style === "ascii"
      ? (["+", "-", "+", "+"] as const)
      : pos === "top"
        ? (["┌", "─", "┐", "┬"] as const)
        : pos === "bot"
          ? (["└", "─", "┘", "┴"] as const)
          : (["├", "─", "┤", "┼"] as const);
  const segs = widths.map((w) => fill.repeat(w + pad * 2));
  return `${left}${segs.join(cross)}${right}`;
}

function fitToWidth(
  widths: number[],
  columns: Column[],
  avail: number,
  pad: number,
): void {
  // Total visible width: sum(content) + inter-cell padding + column separators
  const total =
    widths.reduce((a, b) => a + b, 0) +
    widths.length * 2 * pad +
    widths.length +
    1;
  if (total <= avail) return;

  // Shrink widest columns first, respecting minWidth
  let overflow = total - avail;
  const indices = widths
    .map((_, i) => i)
    .sort((a, b) => widths[b]! - widths[a]!);

  for (const i of indices) {
    if (overflow <= 0) break;
    const minW = columns[i]?.minWidth ?? 0;
    const canShrink = widths[i]! - minW;
    if (canShrink <= 0) continue;
    const shrink = Math.min(canShrink, overflow);
    widths[i] = widths[i]! - shrink;
    overflow -= shrink;
  }
}

/**
 * Truncate to `w` display columns, appending a 1-column "…". Width-aware
 * (CJK/emoji = 2 columns) and surrogate-pair safe; `truncate` preserves any
 * SGR codes and closes them with a reset, so color never bleeds across cells.
 * Only called when the cell is already known to be wider than `w`.
 */
function truncateToWidth(s: string, w: number): string {
  return truncate(s, Math.max(0, w - 1)) + "…";
}
