/**
 * Phase 10A.9 — Pure scrollback search module tests.
 *
 * Covers:
 *   - empty query returns no matches
 *   - case-insensitive search
 *   - multiple matches on one line
 *   - multiple lines
 *   - match cap works
 *   - next/previous wraps
 *   - selectedMatch returns null when no matches
 *   - unusual input never throws
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSearchState,
  findMatches,
  updateSearch,
  moveSearchSelection,
  selectedMatch,
} from "../../src/ui/transcriptSearch.js";
import type { TranscriptSearchState } from "../../src/ui/transcriptSearch.js";

// ── createSearchState ─────────────────────────────────────────────────────────

test("[createSearchState] returns inactive state with empty query and no matches", () => {
  const s = createSearchState();
  assert.equal(s.active, false);
  assert.equal(s.query, "");
  assert.deepEqual(s.matches, []);
  assert.equal(s.selected, 0);
});

// ── findMatches — empty/whitespace query ──────────────────────────────────────

test("[findMatches-empty-query] empty query returns no matches", () => {
  const lines = ["hello world"];
  assert.deepEqual(findMatches(lines, ""), []);
  assert.deepEqual(findMatches(lines, "   "), []);
  assert.deepEqual(findMatches(lines, "\t"), []);
  assert.deepEqual(findMatches(lines, "\n"), []);
});

// ── findMatches — single line ─────────────────────────────────────────────────

test("[findMatches-case-insensitive] search is case-insensitive", () => {
  const lines = ["Hello World"];
  const m = findMatches(lines, "hello");
  assert.equal(m.length, 1);
  assert.equal(m[0].line, 0);
  assert.equal(m[0].start, 0);
  assert.equal(m[0].end, 5);
});

test("[findMatches-case-insensitive-upper] uppercase query matches lowercase text", () => {
  const lines = ["hello world"];
  const m = findMatches(lines, "HELLO");
  assert.equal(m.length, 1);
  assert.equal(m[0].line, 0);
  assert.equal(m[0].start, 0);
  assert.equal(m[0].end, 5);
});

test("[findMatches-case-insensitive-mixed] mixed-case query", () => {
  const lines = ["Hello World"];
  const m = findMatches(lines, "WoRlD");
  assert.equal(m.length, 1);
  assert.equal(m[0].line, 0);
  assert.equal(m[0].start, 6);
  assert.equal(m[0].end, 11);
});

// ── findMatches — multiple matches on one line ────────────────────────────────

test("[findMatches-multiple-per-line] multiple non-overlapping matches on one line", () => {
  const lines = ["foo bar foo baz foo"];
  const m = findMatches(lines, "foo");
  assert.equal(m.length, 3);
  assert.equal(m[0].start, 0);
  assert.equal(m[1].start, 8);
  assert.equal(m[2].start, 16);
});

test("[findMatches-overlapping] overlapping occurrences are non-overlapping (skip consumed chars)", () => {
  // "aaa" with query "aa": positions 0-2 and 1-3 overlap; our algorithm
  // advances past the match, so only the first "aa" at [0,2) is found.
  const lines = ["aaa"];
  const m = findMatches(lines, "aa");
  assert.equal(m.length, 1);
  assert.equal(m[0].start, 0);
  assert.equal(m[0].end, 2);
});

// ── findMatches — multiple lines ──────────────────────────────────────────────

test("[findMatches-multiple-lines] matches across multiple lines", () => {
  const lines = [
    "the first line",
    "second line has the term",
    "third line",
  ];
  const m = findMatches(lines, "the");
  // line 0: "the" at 0
  // line 1: "second line has the " → "the" at index 16
  assert.equal(m.length, 2);
  assert.equal(m[0].line, 0);
  assert.equal(m[0].start, 0);
  assert.equal(m[1].line, 1);
  assert.equal(m[1].start, 16);
});

test("[findMatches-all-lines] hits on every line", () => {
  const lines = ["a", "a", "a"];
  const m = findMatches(lines, "a");
  assert.equal(m.length, 3);
  assert.equal(m[0].line, 0);
  assert.equal(m[1].line, 1);
  assert.equal(m[2].line, 2);
});

// ── findMatches — match cap ────────────────────────────────────────────────────

test("[findMatches-cap] respects MAX_MATCHES cap (500)", () => {
  // Build lines that will generate more than 500 matches
  const line = "a ".repeat(400); // many "a"s
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(line);

  const m = findMatches(lines, "a");
  assert.ok(m.length <= 500, `got ${m.length} matches, expected ≤500`);
  assert.equal(m.length, 500, "should be exactly 500 with enough content");
});

// ── findMatches — unusual input never throws ───────────────────────────────────

test("[findMatches-unusual-input] never throws on unusual input", () => {
  assert.doesNotThrow(() => findMatches([], "hello"));
  assert.doesNotThrow(() => findMatches([""], "hello"));
  assert.doesNotThrow(() => findMatches(["no match here"], "zzz"));
  assert.doesNotThrow(() => findMatches(["emoji 🔍 search"], "🔍"));
  assert.doesNotThrow(() => findMatches(["tab\tseparated"], "\t"));
  assert.doesNotThrow(() => findMatches((undefined as unknown) as readonly string[], "test"));
  assert.doesNotThrow(() => findMatches(["a"], (null as unknown) as string));
});

// ── updateSearch ──────────────────────────────────────────────────────────────

test("[updateSearch] creates matches from query", () => {
  const s = createSearchState();
  const lines = ["hello world", "goodbye"];
  const updated = updateSearch(s, lines, "hello");
  assert.equal(updated.query, "hello");
  assert.equal(updated.matches.length, 1);
  assert.equal(updated.matches[0].line, 0);
  assert.equal(updated.matches[0].start, 0);
  assert.equal(updated.matches[0].end, 5);
});

test("[updateSearch] empty query clears matches", () => {
  const s = createSearchState();
  const lines = ["hello world"];
  const updated = updateSearch(s, lines, "");
  assert.equal(updated.query, "");
  assert.deepEqual(updated.matches, []);
});

test("[updateSearch] whitespace query clears matches", () => {
  const s = createSearchState();
  const lines = ["hello world"];
  const updated = updateSearch(s, lines, "   ");
  assert.equal(updated.query, "   ");
  assert.deepEqual(updated.matches, []);
});

test("[updateSearch] no-match query gives empty matches but preserves query", () => {
  const s = createSearchState();
  const lines = ["hello world"];
  const updated = updateSearch(s, lines, "zzzzz");
  assert.equal(updated.query, "zzzzz");
  assert.deepEqual(updated.matches, []);
});

test("[updateSearch] preserves selected index when matches exist", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "x",
    matches: [{ line: 0, start: 0, end: 1 }],
    selected: 0,
  };
  const lines = ["x hello x world"];
  const updated = updateSearch(s, lines, "x");
  assert.equal(updated.matches.length, 2);
  // selected should be preserved (clamped to 0 if out of range, but 0 is valid)
  assert.equal(updated.selected, 0);
});

test("[updateSearch] resets selected to 0 when query changes to no matches", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "hello",
    matches: [{ line: 0, start: 0, end: 5 }],
    selected: 0,
  };
  const updated = updateSearch(s, ["no match here"], "zzz");
  assert.equal(updated.selected, 0);
  assert.deepEqual(updated.matches, []);
});

// ── moveSearchSelection ───────────────────────────────────────────────────────

test("[moveSearchSelection-next] moves to next match", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 0, end: 1 },
      { line: 2, start: 0, end: 1 },
    ],
    selected: 0,
  };
  const next = moveSearchSelection(s, 1);
  assert.equal(next.selected, 1);
});

test("[moveSearchSelection-previous] moves to previous match", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 0, end: 1 },
      { line: 2, start: 0, end: 1 },
    ],
    selected: 1,
  };
  const prev = moveSearchSelection(s, -1);
  assert.equal(prev.selected, 0);
});

test("[moveSearchSelection-wrap-next] wraps around from last to first", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 0, end: 1 },
    ],
    selected: 1,
  };
  const next = moveSearchSelection(s, 1);
  assert.equal(next.selected, 0);
});

test("[moveSearchSelection-wrap-previous] wraps around from first to last", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 0, end: 1 },
    ],
    selected: 0,
  };
  const prev = moveSearchSelection(s, -1);
  assert.equal(prev.selected, 1);
});

test("[moveSearchSelection-no-matches] no-op when there are no matches", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "",
    matches: [],
    selected: 0,
  };
  const next = moveSearchSelection(s, 1);
  assert.equal(next.selected, 0);
  assert.deepEqual(next.matches, []);
});

// ── selectedMatch ─────────────────────────────────────────────────────────────

test("[selectedMatch-null-empty] returns null when no matches", () => {
  const s = createSearchState();
  assert.equal(selectedMatch(s), null);
});

test("[selectedMatch-null-zero-matches] returns null with empty matches array", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "test",
    matches: [],
    selected: 0,
  };
  assert.equal(selectedMatch(s), null);
});

test("[selectedMatch-returns-match] returns the selected match", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [
      { line: 2, start: 5, end: 6 },
      { line: 3, start: 10, end: 11 },
    ],
    selected: 1,
  };
  const sm = selectedMatch(s);
  assert.notEqual(sm, null);
  assert.equal(sm!.line, 3);
  assert.equal(sm!.start, 10);
  assert.equal(sm!.end, 11);
});

test("[selectedMatch-out-of-range] returns null when selected index is out of range", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [{ line: 0, start: 0, end: 1 }],
    selected: 5,
  };
  assert.equal(selectedMatch(s), null);
});

test("[selectedMatch-negative-index] returns null when selected index is negative", () => {
  const s: TranscriptSearchState = {
    active: true,
    query: "a",
    matches: [{ line: 0, start: 0, end: 1 }],
    selected: -1,
  };
  assert.equal(selectedMatch(s), null);
});

// ── createSearchState + updateSearch integration ──────────────────────────────

test("[integration-typical-flow] typical search flow: create → update → navigate → selectedMatch", () => {
  const lines = [
    "the quick brown fox",
    "jumps over the lazy dog",
    "the end",
  ];

  let s = createSearchState();

  // Activate with query
  s = { ...s, active: true };
  s = updateSearch(s, lines, "the");

  assert.equal(s.matches.length, 3);
  assert.equal(s.matches[0].line, 0);
  assert.equal(s.matches[0].start, 0);
  assert.equal(s.matches[1].line, 1);
  assert.equal(s.matches[1].start, 11); // "jumps over the …" → "the" at index 11
  assert.equal(s.matches[2].line, 2);
  assert.equal(s.matches[2].start, 0);

  // Selected is first match initially
  let sel = selectedMatch(s);
  assert.notEqual(sel, null);
  assert.equal(sel!.line, 0);

  // Move next
  s = moveSearchSelection(s, 1);
  sel = selectedMatch(s);
  assert.equal(sel!.line, 1);

  // Move next
  s = moveSearchSelection(s, 1);
  sel = selectedMatch(s);
  assert.equal(sel!.line, 2);

  // Wrap around
  s = moveSearchSelection(s, 1);
  sel = selectedMatch(s);
  assert.equal(sel!.line, 0);

  // Move previous wraps to last
  s = moveSearchSelection(s, -1);
  sel = selectedMatch(s);
  assert.equal(sel!.line, 2);

  // Change query to no matches
  s = updateSearch(s, lines, "zzzz");
  assert.equal(s.matches.length, 0);
  assert.equal(selectedMatch(s), null);
});
