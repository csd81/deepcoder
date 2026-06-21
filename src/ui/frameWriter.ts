/**
 * Phase 10A full TUI — diff-based frame writer (pure, no I/O).
 *
 * The TUI renders each frame as an array of terminal lines (see minimalRenderer).
 * Instead of clearing the whole screen and rewriting every frame (which flickers
 * during streaming), `diffFrames` compares the previously-drawn frame to the next
 * one and emits terminal ops that repaint ONLY the lines that changed.
 *
 * Line index `i` maps to terminal row `i + 1` (rows are 1-based). A changed line
 * is repainted with: cursor-to-row, erase-line, then the new content. A line that
 * disappeared (the frame shrank) is cleared with no content. Unchanged lines emit
 * nothing, so a steady screen with one changing line costs one line's worth of ops.
 */

/** Move the cursor to (row, col=1). Rows/cols are 1-based, per ANSI. */
function cursorTo(row: number): string {
  return `\x1b[${row};1H`;
}

/** Erase the entire current line. */
const ERASE_LINE = "\x1b[2K";

/**
 * Produce the terminal ops that transform a screen showing `prev` into one
 * showing `next`, repainting only changed lines. Returns "" when nothing changed.
 */
export function diffFrames(prev: readonly string[], next: readonly string[]): string {
  const ops: string[] = [];
  const max = Math.max(prev.length, next.length);
  for (let i = 0; i < max; i++) {
    const before = prev[i];
    const after = next[i];
    if (before === after) continue;
    const move = cursorTo(i + 1) + ERASE_LINE;
    // `after === undefined` means the frame shrank past this row: clear it, no content.
    ops.push(after === undefined ? move : move + after);
  }
  return ops.join("");
}
