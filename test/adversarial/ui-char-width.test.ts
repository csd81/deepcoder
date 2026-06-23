/**
 * UI display-width (CJK / emoji / combining) — pure wcwidth-style width.
 *
 * Covers:
 *   - charWidth: ASCII=1, CJK/fullwidth/emoji=2, combining/zero-width/control=0.
 *   - displayWidth: sums code-point widths, ignores SGR color codes, counts
 *     astral (surrogate-pair) code points once.
 *   - visibleWidth (minimalRenderer) now reports display columns, not code points.
 *   - truncate cuts by display columns, never splits a surrogate pair, and drops
 *     a wide char that would straddle the limit rather than overflow.
 *   - wrapLine wraps by display columns, not by .length.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { charWidth, displayWidth } from "../../src/ui/charWidth.js";
import { visibleWidth, truncate } from "../../src/ui/minimalRenderer.js";
import { wrapLine } from "../../src/ui/textLayout.js";

// ── charWidth ────────────────────────────────────────────────────────────────

test("[charWidth] ASCII is one column", () => {
  assert.equal(charWidth(0x41), 1); // 'A'
  assert.equal(charWidth(0x20), 1); // space
});

test("[charWidth] CJK and fullwidth are two columns", () => {
  assert.equal(charWidth(0x4f60), 2); // 你
  assert.equal(charWidth(0xff21), 2); // fullwidth 'Ａ'
  assert.equal(charWidth(0xac00), 2); // Hangul 가
});

test("[charWidth] emoji (astral) is two columns", () => {
  assert.equal(charWidth(0x1f600), 2); // 😀
});

test("[charWidth] combining and zero-width are zero columns", () => {
  assert.equal(charWidth(0x0301), 0); // combining acute accent
  assert.equal(charWidth(0x200b), 0); // zero-width space
  assert.equal(charWidth(0xfe0f), 0); // variation selector-16
});

// ── displayWidth ─────────────────────────────────────────────────────────────

test("[displayWidth] ASCII string", () => {
  assert.equal(displayWidth("hello"), 5);
});

test("[displayWidth] CJK string counts two per char", () => {
  assert.equal(displayWidth("你好"), 4);
  assert.equal(displayWidth("a你b"), 4);
});

test("[displayWidth] emoji counts two, not the surrogate-pair length", () => {
  assert.equal("😀".length, 2); // sanity: JS UTF-16 length is 2
  assert.equal(displayWidth("😀"), 2);
});

test("[displayWidth] combining mark adds nothing", () => {
  assert.equal(displayWidth("é"), 1); // é (decomposed: e + U+0301)
});

test("[displayWidth] ignores SGR color codes", () => {
  assert.equal(displayWidth("\x1b[31m你好\x1b[0m"), 4);
});

// ── visibleWidth (re-exported behavior) ──────────────────────────────────────

test("[visibleWidth] reports display columns for wide text", () => {
  assert.equal(visibleWidth("你好"), 4);
  assert.equal(visibleWidth("\x1b[1m你\x1b[0m"), 2);
});

// ── truncate ─────────────────────────────────────────────────────────────────

test("[truncate] cuts CJK by display columns", () => {
  assert.equal(truncate("你好世界", 4), "你好");
});

test("[truncate] drops a wide char that would straddle the limit", () => {
  // 好 (cols 3-4) cannot fit in a 3-col budget after 你 (cols 1-2) → stop at 你.
  assert.equal(truncate("你好", 3), "你");
});

test("[truncate] never splits a surrogate pair", () => {
  // budget 2 fits one emoji (2 cols); the second would overflow.
  assert.equal(truncate("😀😀", 2), "😀");
  // budget 1 cannot fit a 2-col emoji at all.
  assert.equal(truncate("😀", 1), "");
});

test("[truncate] preserves SGR codes and appends reset when cut while styled", () => {
  assert.equal(truncate("\x1b[31m你好\x1b[0m", 2), "\x1b[31m你\x1b[0m");
});

test("[truncate] leaves a fitting string unchanged", () => {
  assert.equal(truncate("你好", 4), "你好");
  assert.equal(truncate("abc", 10), "abc");
});

// ── wrapLine ─────────────────────────────────────────────────────────────────

test("[wrapLine] wraps CJK by display columns, not code-point count", () => {
  // 4 wide chars = 8 columns; at width 4 that is two rows of 2 chars each.
  assert.deepEqual(wrapLine("你好世界", 4), ["你好", "世界"]);
});

test("[wrapLine] a fitting wide line is returned verbatim", () => {
  assert.deepEqual(wrapLine("你好", 4), ["你好"]);
});
