/**
 * Phase 10A full TUI — text layout / wrapping (pure, no I/O).
 *
 * Wraps logical lines to the terminal width so output is readable (replacing the
 * old truncate-only behavior) and so a resize can re-wrap cleanly. Operates on
 * PLAIN text — semantic color is applied later, per wrapped line — so wrapping
 * itself needs no ANSI awareness. Word-aware: break at spaces when possible,
 * hard-split a token longer than the width.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { wrapLine, wrapLines } from "../../src/ui/textLayout.js";

test("a line within width is returned unchanged", () => {
  assert.deepEqual(wrapLine("hello world", 20), ["hello world"]);
});

test("a long line wraps at word boundaries, each chunk within width", () => {
  const chunks = wrapLine("the quick brown fox jumps", 10);
  for (const c of chunks) assert.ok(c.length <= 10, `chunk "${c}" within width`);
  assert.equal(chunks.join(" "), "the quick brown fox jumps", "no words lost or split");
});

test("a single token longer than width is hard-split", () => {
  const chunks = wrapLine("supercalifragilistic", 5);
  for (const c of chunks) assert.ok(c.length <= 5);
  assert.equal(chunks.join(""), "supercalifragilistic", "all characters preserved");
});

test("an empty line is preserved as one empty line", () => {
  assert.deepEqual(wrapLine("", 10), [""]);
});

test("width <= 0 returns the line unchanged (no crash, no infinite loop)", () => {
  assert.deepEqual(wrapLine("abc", 0), ["abc"]);
});

test("wrapLines flattens multiple logical lines and preserves blanks", () => {
  const out = wrapLines(["one two three", "", "x"], 7);
  assert.deepEqual(out, ["one two", "three", "", "x"]);
});
