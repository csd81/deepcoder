# Feature — Dynamic table rendering in TUI

## Context

Several slash commands output structured data as raw `console.log` lines: `/sessions` lists sessions, `/checkpoints` lists checkpoints, `/doctor` shows findings, `/status` shows config. The output is unstructured and hard to scan. Both opencode and Claude Code render this data as formatted terminal tables with auto-sized columns, headers, and optional sorting.

Deepcoder's rendering pipeline is pure (`minimalRenderer.ts` takes `string[]` and produces frame lines). A table renderer just produces formatted `string[]` — no I/O, no TUI changes needed at the frame level.

## Model

- A pure `renderTable(columns, rows)` function that produces a `string[]` of formatted lines.
- Slash commands that output structured data use `renderTable` instead of `console.log`.
- Columns auto-size: width = min(max content width, maxWidth), with configurable minWidth.
- Respects terminal width: if total exceeds available columns, long columns are truncated.
- Supports both box-drawing (`│ ─ ┼`) and ASCII (`| - +`) mode — detected from terminal or config.

## Design

### 1. Pure module `src/ui/table.ts`

```ts
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

export function renderTable(columns: Column[], rows: string[][], opts?: TableOptions): string[] {
  const style = opts?.style ?? "unicode";
  const pad = opts?.padding ?? 1;
  const avail = opts?.availableWidth;

  // 1. Calculate column widths: auto from max content, capped by maxWidth, floored by minWidth
  const widths = columns.map((col, i) => {
    const contentWidths = rows.map((r) => visibleWidth(r[i] ?? ""));
    const maxContent = Math.max(col.header.length, ...contentWidths);
    const clamped = Math.min(maxContent, col.maxWidth ?? Infinity);
    return Math.max(clamped, col.minWidth ?? 0);
  });

  // 2. If total exceeds available width, shrink widest columns proportionally
  if (avail) fitToWidth(widths, columns, avail, pad);

  // 3. Build separator + header + rows
  const sepChar = style === "ascii" ? ["+", "-", "+"] : ["├", "─", "┤"];
  const out: string[] = [];

  out.push(renderSep(widths, pad, style, "top"));
  out.push(renderRow(columns.map((c) => c.header), widths, pad, style));
  out.push(renderSep(widths, pad, style, "mid"));

  for (const row of rows) {
    out.push(renderRow(row, widths, pad, style));
  }

  out.push(renderSep(widths, pad, style, "bot"));
  return out;
}

function renderRow(cells: string[], widths: number[], pad: number, style: TableOptions["style"]): string {
  const sep = style === "ascii" ? "|" : "│";
  const parts = cells.map((c, i) => {
    const w = widths[i]!;
    const visible = visibleWidth(c);
    // Truncate if wider than column
    const text = visible > w ? truncateToWidth(c, w) : c.padEnd(w + (visible - c.length));
    return " ".repeat(pad) + text + " ".repeat(pad);
  });
  return `${sep}${parts.join(sep)}${sep}`;
}

function renderSep(widths: number[], pad: number, style: TableOptions["style"], pos: "top" | "mid" | "bot"): string {
  const [left, fill, right, cross] = style === "ascii"
    ? ["+", "-", "+", "+"]
    : pos === "top" ? ["┌", "─", "┐", "┬"]
    : pos === "bot" ? ["└", "─", "┘", "┴"]
    : ["├", "─", "┤", "┼"];
  const segs = widths.map((w) => fill.repeat(w + pad * 2));
  return `${left}${segs.join(cross)}${right}`;
}

function fitToWidth(widths: number[], columns: Column[], avail: number, pad: number): void {
  const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * pad * 2 + widths.length + 1;
  if (total <= avail) return;
  // Shrink widest columns first, respecting minWidth
  let overflow = total - avail;
  const indices = widths.map((w, i) => i).sort((a, b) => widths[b]! - widths[a]!);
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

function visibleWidth(s: string): number {
  // Strip ANSI + count grapheme clusters; simplest: s.length for now
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function truncateToWidth(s: string, w: number): string {
  const cleaned = s.replace(/\u001b\[[0-9;]*m/g, "");
  return cleaned.length > w ? cleaned.slice(0, w - 1) + "…" : cleaned;
}
```

### 2. Wire into existing slash commands

Replace `console.log` lines with `renderTable` calls:

```ts
// /sessions (slashCommands.ts):
case "sessions": {
  const all = await listSessions(config.workspaceRoot);
  const cols: Column[] = [
    { header: "ID", maxWidth: 28 },
    { header: "Title", maxWidth: 30 },
    { header: "Msgs", align: "right" },
    { header: "Updated" },
  ];
  const rows = all.map((s) => [
    s.id,
    s.title ?? "",
    String(s.messageCount),
    s.updatedAt.slice(0, 10),
  ]);
  const table = renderTable(cols, rows, { availableWidth: process.stdout.columns });
  table.forEach((l) => console.log(l));
  return { consumed: true };
}
```

Other candidates: `/checkpoints`, `/doctor --table`, `/memory inbox`, `/status --table`, `/ps`.

### 3. File save variant (`--csv`)

SHOULD: when a slash command has `--csv`, emit a CSV string instead of a formatted table for piping to files.

## Files

- **New:** `src/ui/table.ts`, `test/table.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (migrate `/sessions`, `/checkpoints`, `/ps` to use renderTable), `src/cli/slashCatalog.ts`.

## Tests

- `renderTable` with 2 columns + 3 rows → 7 lines (top, header, mid, 3 data, bot).
- `renderTable` with empty rows → 3 lines (top, header, bot).
- `renderTable` auto-calculates widths from longest content.
- `renderTable` with `availableWidth` truncates oversized tables.
- `renderTable` with `ascii` style uses `|` `-` `+` instead of box-drawing.
- A cell wider than column maxWidth → truncated with `…`.
- `visibleWidth` excludes ANSI escape codes from column width calc.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: `/sessions` shows a clean table with header, border, and right-aligned message count.
3. `/checkpoints` shows checkpoint list in table format.
4. Narrow terminal → columns shrink proportional to minWidth.

## Safety

- Pure function — no I/O, no state, no permission surface.
- Falls back to unformatted output if table rendering throws (defensive).
