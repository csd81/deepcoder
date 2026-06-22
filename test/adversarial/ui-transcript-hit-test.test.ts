/**
 * Phase 10A.10 — pure transcript hit-testing for click-to-toggle.
 * Maps a clicked terminal row to the collapsible block header it lands on
 * (or null), and computes the frame's row regions deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFrameRegions,
  hitTestBlock,
  type RenderedTranscriptRow,
} from "../../src/ui/transcriptHitTest.js";

const rows: RenderedTranscriptRow[] = [
  { text: "> hello", kind: "user" },
  { text: "▸ tool read_file", blockId: "t1", kind: "tool", header: true, collapsible: true },
  { text: "▾ check phase ✓", blockId: "c1", kind: "check", header: true, collapsible: true },
  { text: "  tests 412 passed", blockId: "c1", kind: "check", header: false, collapsible: true }, // expanded body
  { text: "assistant> done", kind: "assistant" },
];

test("collapsible header row maps to its block id", () => {
  assert.equal(hitTestBlock(rows, 0, 1), "t1");
  assert.equal(hitTestBlock(rows, 0, 2), "c1");
});

test("expanded body row is not a toggle target", () => {
  assert.equal(hitTestBlock(rows, 0, 3), null); // header:false
});

test("user / assistant rows are not toggle targets", () => {
  assert.equal(hitTestBlock(rows, 0, 0), null);
  assert.equal(hitTestBlock(rows, 0, 4), null);
});

test("viewport offset is respected", () => {
  // scrolled so the check header (index 2) is the first visible row
  assert.equal(hitTestBlock(rows, 2, 0), "c1");
  assert.equal(hitTestBlock(rows, 2, 1), null); // index 3, body
});

test("row outside the content returns null", () => {
  assert.equal(hitTestBlock(rows, 0, 99), null);
  assert.equal(hitTestBlock(rows, 0, -1), null);
});

test("computeFrameRegions: status / transcript / composer offsets (0-based)", () => {
  const r = computeFrameRegions({ height: 10, composerRows: 1 });
  assert.equal(r.statusRow, 0);
  assert.equal(r.transcriptStartRow, 1);
  assert.equal(r.transcriptEndRow, 10); // rows 1..10 inclusive
  assert.equal(r.composerStartRow, 11); // no indicator, no menu
});

test("computeFrameRegions: indicator + menu rows push the composer down", () => {
  const r = computeFrameRegions({ height: 8, composerRows: 2, hasIndicator: true, menuRows: 3 });
  assert.equal(r.transcriptStartRow, 1);
  assert.equal(r.transcriptEndRow, 8);
  // 1 (status) + 8 (transcript) + 1 (indicator) + 3 (menu) = 13
  assert.equal(r.composerStartRow, 13);
});
