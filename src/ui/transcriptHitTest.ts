/**
 * Phase 10A.10 — pure transcript hit-testing for mouse click-to-toggle.
 *
 * The TUI renders transcript blocks into wrapped display rows. To map a mouse
 * click back to a block we need (a) per-row metadata (which block a row belongs
 * to, and whether it is that block's collapsible header) and (b) the frame's
 * row geometry. Both are pure and unit-tested here; the I/O shell produces the
 * row metadata during its render pass and feeds clicks through hitTestBlock.
 */
import type { TranscriptBlock } from "./transcript.js";

export interface RenderedTranscriptRow {
  text: string;
  blockId?: string;
  kind?: TranscriptBlock["kind"];
  /** True only for a collapsible block's first (header) row — the toggle target. */
  header?: boolean;
  collapsible?: boolean;
}

export interface FrameRegions {
  /** 0-based frame index of the status bar. */
  statusRow: number;
  /** 0-based frame index of the first transcript row. */
  transcriptStartRow: number;
  /** 0-based frame index of the last transcript row (inclusive). */
  transcriptEndRow: number;
  /** 0-based frame index of the first composer row. */
  composerStartRow: number;
}

/**
 * Frame layout (top to bottom): status(1) · transcript(height) · indicator(0|1)
 * · menu(menuRows) · composer(composerRows). Returns 0-based row indices.
 */
export function computeFrameRegions(opts: {
  height: number;
  composerRows: number;
  hasIndicator?: boolean;
  menuRows?: number;
}): FrameRegions {
  const height = Math.max(0, opts.height);
  const indicator = opts.hasIndicator ? 1 : 0;
  const menu = Math.max(0, opts.menuRows ?? 0);
  const transcriptStartRow = 1;
  const transcriptEndRow = transcriptStartRow + height - 1;
  return {
    statusRow: 0,
    transcriptStartRow,
    transcriptEndRow,
    composerStartRow: transcriptStartRow + height + indicator + menu,
  };
}

/**
 * Given the full transcript rows, the first visible row (`viewportTop`), and the
 * 0-based offset of the clicked row WITHIN the transcript window, return the id
 * of the collapsible block header that was clicked, or null when the click does
 * not land on a toggle target.
 */
export function hitTestBlock(
  rows: RenderedTranscriptRow[],
  viewportTop: number,
  transcriptRowOffset: number,
): string | null {
  if (transcriptRowOffset < 0) return null;
  const idx = viewportTop + transcriptRowOffset;
  if (idx < 0 || idx >= rows.length) return null;
  const row = rows[idx];
  if (row.collapsible && row.header && row.blockId) return row.blockId;
  return null;
}
