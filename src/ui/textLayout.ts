/**
 * Phase 10A full TUI — text layout / wrapping (pure, no I/O).
 *
 * Wraps logical lines to the terminal width so output stays readable and so a
 * resize can re-wrap cleanly. Operates on PLAIN text (semantic color is applied
 * later, per wrapped line), so wrapping needs no ANSI awareness. Word-aware: pack
 * words up to the width, breaking at spaces; a single token longer than the width
 * is hard-split so nothing is ever lost or runs off-screen.
 */

/** Wrap one logical line to `width` columns. Always returns at least one line. */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line]; // guard: a non-positive width can't wrap
  if (line === "") return [""]; // preserve blank lines
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (word.length > width) {
      // Token longer than the width: flush the current line, then hard-split it.
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      let rest = word;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      cur = rest; // remainder may still accept following words
      continue;
    }
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur !== "" || out.length === 0) out.push(cur);
  return out;
}

/** Wrap many logical lines, preserving order and blank lines. */
export function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((l) => wrapLine(l, width));
}
