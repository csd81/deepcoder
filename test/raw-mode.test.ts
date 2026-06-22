import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRaw, lineWidth } from "../src/ui/rawMode.js";

// Red-seed anchor (do NOT weaken). Pure ANSI stripping + width — no I/O.
const ESC = String.fromCharCode(27); // ESC, start of an ANSI escape

test("renderRaw strips ANSI color codes", () => {
  assert.equal(renderRaw(`${ESC}[31mhello${ESC}[0m`), "hello");
});

test("renderRaw leaves plain text unchanged", () => {
  assert.equal(renderRaw("plain text"), "plain text");
});

test("renderRaw strips compound escape sequences", () => {
  assert.equal(renderRaw(`${ESC}[1m${ESC}[4mbold-underline${ESC}[0m`), "bold-underline");
});

test("lineWidth ignores ANSI when raw=true, counts raw chars when false", () => {
  const styled = `${ESC}[31mhello${ESC}[0m`;
  assert.equal(lineWidth(true, styled), 5);
  assert.equal(lineWidth(false, styled), styled.length);
});
