import { test } from "node:test";
import assert from "node:assert/strict";
import { mouseStatusNotice, MOUSE_ENABLE, MOUSE_DISABLE } from "../src/ui/mouse.js";

// The terminal mouse protocol cannot give the app wheel-scroll events AND let the
// terminal do modifier-free click-drag selection at the same time: capturing the
// mouse for the wheel is exactly what suppresses native selection. So the TUI
// offers a runtime toggle (Ctrl+G) between the two, and tells the user which is
// active and how to do the other.

test("notice for capture ON explains scroll works and how to select", () => {
  const n = mouseStatusNotice(true);
  assert.match(n, /scroll/i);
  assert.match(n, /shift/i); // Shift+drag is the in-capture selection bypass
});

test("notice for capture OFF explains selection works and how to scroll", () => {
  const n = mouseStatusNotice(false);
  assert.match(n, /select|drag/i);
  assert.match(n, /pgup|pgdn|page/i); // keyboard scroll while the mouse is released
});

test("enable/disable sequences are distinct, non-empty control strings", () => {
  assert.notEqual(MOUSE_ENABLE, MOUSE_DISABLE);
  assert.ok(MOUSE_ENABLE.length > 0 && MOUSE_DISABLE.length > 0);
});
