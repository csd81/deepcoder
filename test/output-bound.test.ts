import { test } from "node:test";
import assert from "node:assert/strict";
import { boundLines, boundText, truncationMarker } from "../src/tools/outputBound.js";

test("boundLines returns the input unchanged when within the cap", () => {
  const lines = ["a", "b", "c"];
  assert.equal(boundLines(lines, 5), lines); // same reference
  assert.equal(boundLines(lines, 3), lines);
});

test("boundLines caps and appends an explicit truncation marker", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const out = boundLines(lines, 4, "matches");
  assert.equal(out.length, 5); // 4 + marker
  assert.deepEqual(out.slice(0, 4), lines.slice(0, 4));
  assert.match(out[4]!, /4 of 10 matches shown; truncated/);
});

test("boundText caps by line count with a marker", () => {
  const text = Array.from({ length: 8 }, (_, i) => `L${i}`).join("\n");
  const out = boundText(text, 3);
  const outLines = out.split("\n");
  assert.equal(outLines.length, 4);
  assert.match(outLines[3]!, /3 of 8 lines shown; truncated/);
  // within bounds → unchanged
  assert.equal(boundText("a\nb", 5), "a\nb");
});

test("truncationMarker formats shown/total", () => {
  assert.match(truncationMarker(100, 4000, "matches"), /100 of 4000 matches shown; truncated/);
});
