/**
 * Phase 10A full TUI — text layout / wrapping (pure, no I/O).
 *
 * Wraps logical lines to the terminal width so output stays readable and so a
 * resize can re-wrap cleanly. Operates on PLAIN text (semantic color is applied
 * later, per wrapped line), so wrapping needs no ANSI awareness. Word-aware: pack
 * words up to the width, breaking at spaces; a single token longer than the width
 * is hard-split so nothing is ever lost or runs off-screen. Width is measured in
 * display columns (CJK/emoji = 2, combining = 0) so wide text wraps correctly.
 */

import { charWidth, displayWidth } from "./charWidth.js";

/**
 * Split `s` into a leading chunk of at most `width` display columns and the
 * remainder, never cutting a surrogate pair and never splitting a wide character
 * across the boundary.
 */
function takeColumns(s: string, width: number): [string, string] {
  let i = 0;
  let cols = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i)!;
    const w = charWidth(cp);
    if (cols + w > width) break;
    cols += w;
    i += String.fromCodePoint(cp).length;
  }
  return [s.slice(0, i), s.slice(i)];
}

/** Wrap one logical line to `width` columns. Always returns at least one line. */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line]; // guard: a non-positive width can't wrap
  if (line === "") return [""]; // preserve blank lines
  // A line that already fits is returned verbatim — this preserves leading
  // indentation AND internal whitespace runs (critical for code; the old
  // split(" ")/rejoin path silently dropped leading spaces).
  if (displayWidth(line) <= width) return [line];
  // Preserve leading indentation across the wrap: strip it for tokenizing and
  // re-attach it to the first emitted chunk.
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const body = indent ? line.slice(indent.length) : line;
  const out: string[] = [];
  let cur = "";
  for (const word of body.split(" ")) {
    if (displayWidth(word) > width) {
      // Token wider than the width: flush the current line, then hard-split it
      // by display columns.
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      let rest = word;
      while (displayWidth(rest) > width) {
        const [chunk, remainder] = takeColumns(rest, width);
        // Defensive: a single char wider than `width` can't fit — emit it alone
        // so we never loop forever.
        if (chunk === "") {
          const cp = rest.codePointAt(0)!;
          const first = String.fromCodePoint(cp);
          out.push(first);
          rest = rest.slice(first.length);
          continue;
        }
        out.push(chunk);
        rest = remainder;
      }
      cur = rest; // remainder may still accept following words
      continue;
    }
    if (cur === "") cur = word;
    else if (displayWidth(cur) + 1 + displayWidth(word) <= width) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur !== "" || out.length === 0) out.push(cur);
  if (indent) out[0] = indent + out[0];
  return out;
}

/** Wrap many logical lines, preserving order and blank lines. */
export function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((l) => wrapLine(l, width));
}
