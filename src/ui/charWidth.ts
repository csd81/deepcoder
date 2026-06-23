/**
 * Display-width of Unicode text for terminal layout (pure, zero-dep).
 *
 * A wcwidth-style approximation: most characters occupy one terminal column,
 * East-Asian wide / fullwidth characters and emoji occupy two, and combining
 * marks / zero-width / control characters occupy none. This is what every
 * width-sensitive renderer (truncation, wrapping, padding, the status bar and
 * tables) must use instead of a naive code-point or `.length` count, which
 * misaligns CJK and emoji and can slice a surrogate pair or grapheme apart.
 *
 * The ranges below port the widely-used tables from Markus Kuhn's wcwidth.c
 * (zero-width combining marks) plus the East Asian Wide/Fullwidth blocks and the
 * common emoji ranges. It is intentionally a fixed table — deterministic, no I/O,
 * no dependency — matching the rest of the UI layer's design.
 */

/** SGR (color) escape sequence matcher — these are zero-width on screen. */
const SGR = /\x1b\[[0-9;]*m/g;

// Sorted, non-overlapping [lo, hi] inclusive ranges of zero-width code points:
// combining marks, zero-width spaces/joiners, and variation selectors.
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x0901, 0x0902],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x135d, 0x135f],
  [0x1ab0, 0x1aff], // combining diacritical marks extended
  [0x1b6b, 0x1b73],
  [0x1dc0, 0x1dff], // combining diacritical marks supplement
  [0x200b, 0x200f], // zero-width space/joiner/non-joiner, LRM/RLM
  [0x2028, 0x202e],
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
  [0x1d167, 0x1d169],
  [0x1d17b, 0x1d182],
  [0x1d185, 0x1d18b],
  [0x1d1aa, 0x1d1ad],
  [0xe0100, 0xe01ef], // variation selectors supplement
];

// Sorted, non-overlapping [lo, hi] inclusive ranges of wide (two-column) code
// points: East Asian Wide & Fullwidth blocks plus common emoji.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols & punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols, enclosed CJK
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables / Radicals
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // playing card black joker
  [0x1f300, 0x1f64f], // Misc Symbols & Pictographs, Emoticons
  [0x1f680, 0x1f6ff], // Transport & Map Symbols
  [0x1f900, 0x1f9ff], // Supplemental Symbols & Pictographs
  [0x1fa70, 0x1faff], // Symbols & Pictographs Extended-A
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extension B and beyond
];

/** True when `cp` falls inside any [lo, hi] range (binary search). */
function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Number of terminal columns a single code point occupies: 0 for combining /
 * zero-width / control characters, 2 for East-Asian-wide / fullwidth / emoji,
 * 1 otherwise.
 */
export function charWidth(cp: number): number {
  // C0 control + DEL + C1 control: no advance (callers should not emit these,
  // but counting them as zero keeps width estimates honest).
  if (cp === 0 || (cp >= 0x7f && cp < 0xa0) || cp < 0x20) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/**
 * Display-column width of a string, ignoring SGR color codes (zero-width on
 * screen) and counting astral (surrogate-pair) code points once.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(SGR, "")) {
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}
