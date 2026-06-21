/**
 * Phase 10A full TUI — diff-based frame writer (pure, no TTY).
 *
 * diffFrames(prev, next) returns the minimal terminal ops (ANSI) that transform a
 * screen currently showing `prev` into one showing `next`, repainting ONLY the
 * lines that changed. This is the anti-flicker core: streaming updates no longer
 * clear+redraw the whole screen.
 *
 * Line index i maps to terminal row i+1 (1-based). A repaint of one line is:
 *   ESC[<row>;1H   (cursor to row, col 1)
 *   ESC[2K         (erase entire line)
 *   <content>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { diffFrames } from "../../src/ui/frameWriter.js";

test("identical frames produce no terminal ops", () => {
  const frame = ["status", "hello", "> "];
  assert.equal(diffFrames(frame, [...frame]), "");
});

test("only the changed line is repainted (others untouched)", () => {
  const prev = ["status", "hello", "> "];
  const next = ["status", "HELLO", "> "];
  const ops = diffFrames(prev, next);
  // Row 2 (index 1) is repainted: position to row 2, erase, new content.
  assert.ok(ops.includes("\x1b[2;1H"), "positions to the changed row (2)");
  assert.ok(ops.includes("\x1b[2K"), "erases the changed line");
  assert.ok(ops.includes("HELLO"), "writes the new content");
  // Unchanged rows are NOT addressed.
  assert.ok(!ops.includes("\x1b[1;1H"), "row 1 (unchanged) is not repainted");
  assert.ok(!ops.includes("\x1b[3;1H"), "row 3 (unchanged) is not repainted");
});

test("growth: new trailing lines are written", () => {
  const prev = ["a", "b"];
  const next = ["a", "b", "c", "d"];
  const ops = diffFrames(prev, next);
  assert.ok(!ops.includes("\x1b[1;1H"), "row 1 unchanged");
  assert.ok(!ops.includes("\x1b[2;1H"), "row 2 unchanged");
  assert.ok(ops.includes("\x1b[3;1H") && ops.includes("c"), "row 3 written");
  assert.ok(ops.includes("\x1b[4;1H") && ops.includes("d"), "row 4 written");
});

test("shrink: removed trailing rows are cleared", () => {
  const prev = ["a", "b", "c", "d"];
  const next = ["a", "b"];
  const ops = diffFrames(prev, next);
  assert.ok(!ops.includes("\x1b[1;1H") && !ops.includes("\x1b[2;1H"), "kept rows untouched");
  assert.ok(ops.includes("\x1b[3;1H\x1b[2K"), "row 3 cleared");
  assert.ok(ops.includes("\x1b[4;1H\x1b[2K"), "row 4 cleared");
  assert.ok(!ops.includes("c") && !ops.includes("d"), "no stale content rewritten");
});

test("full repaint from empty draws every line", () => {
  const ops = diffFrames([], ["x", "y"]);
  assert.ok(ops.includes("\x1b[1;1H") && ops.includes("x"));
  assert.ok(ops.includes("\x1b[2;1H") && ops.includes("y"));
});
