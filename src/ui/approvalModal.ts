/**
 * Phase 10A full TUI — approval modal renderer (pure, no I/O).
 *
 * Builds the bounded rows for a pending permission request: a title, the wrapped
 * description, a scrollable unified-diff body, and a key-hint footer. The shell
 * renders these in place of the transcript window while an approval is pending.
 */

import type { Theme } from "./theme.js";
import { wrapLine } from "./textLayout.js";

export interface ApprovalModalInput {
  description: string;
  diff?: string;
  width: number;
  height: number;
  /** Scroll offset into the diff body. */
  scroll: number;
  theme: Theme;
}

/** Color a single unified-diff line by its leading marker. */
function styleDiffLine(line: string, theme: Theme): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.success(line);
  if (line.startsWith("-") && !line.startsWith("---")) return theme.error(line);
  if (line.startsWith("@@")) return theme.dim(line);
  return line;
}

export function renderApprovalModal(input: ApprovalModalInput): string[] {
  const { description, diff, width, height, scroll, theme } = input;
  const rows: string[] = [];

  rows.push(theme.title("⚠ Permission required"));
  for (const ln of wrapLine(description, width)) rows.push(ln);
  rows.push(theme.dim("─".repeat(Math.max(1, Math.min(width, 40)))));

  const footer = theme.dim("[y] approve  [n] deny  ↑/↓ scroll diff");
  // Rows reserved for everything except the diff body.
  const chrome = rows.length + 1; // + footer
  const bodyHeight = Math.max(0, height - chrome);

  if (diff && bodyHeight > 0) {
    const diffLines = diff.split("\n");
    const start = Math.max(0, Math.min(scroll, Math.max(0, diffLines.length - 1)));
    const window = diffLines.slice(start, start + bodyHeight);
    for (const ln of window) rows.push(styleDiffLine(ln, theme));
  }

  rows.push(footer);
  return rows.slice(0, height);
}
