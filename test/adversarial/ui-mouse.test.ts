/**
 * Phase 10A7 (Slice 2) — Mouse Wheel Parser. Pure SGR mouse parsing for
 * transcript scrollback. Covers the plan's "Tests" bullets: parses
 * wheel-up/wheel-down sequences, ignores unsupported mouse events, malformed
 * input returns null, and the documented disable sequence is exported so the
 * TUI restore can emit it. Also verifies a wheel event with a modifier bit set
 * still classifies correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSgrMouse, MOUSE_ENABLE, MOUSE_DISABLE } from "../../src/ui/mouse.js";

test("[mouse-wheel-up] parses a wheel-up SGR escape sequence", () => {
  const ev = parseSgrMouse("\x1b[<64;10;5M");
  assert.deepEqual(ev, { kind: "wheel-up", x: 10, y: 5 });
});

test("[mouse-wheel-down] parses a wheel-down SGR escape sequence", () => {
  const ev = parseSgrMouse("\x1b[<65;3;20M");
  assert.deepEqual(ev, { kind: "wheel-down", x: 3, y: 20 });
});

test("[mouse-wheel-release-m] parses wheel events with the release final byte 'm'", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<64;1;1m"), { kind: "wheel-up", x: 1, y: 1 });
  assert.deepEqual(parseSgrMouse("\x1b[<65;1;1m"), { kind: "wheel-down", x: 1, y: 1 });
});

test("[mouse-ignore-buttons] ignores normal button press/release events (returns null)", () => {
  assert.equal(parseSgrMouse("\x1b[<0;10;5M"), null); // left press
  assert.equal(parseSgrMouse("\x1b[<0;10;5m"), null); // left release
  assert.equal(parseSgrMouse("\x1b[<1;10;5M"), null); // middle
  assert.equal(parseSgrMouse("\x1b[<2;10;5M"), null); // right
});

test("[mouse-ignore-motion] ignores motion / drag events (returns null)", () => {
  assert.equal(parseSgrMouse("\x1b[<32;10;5M"), null); // button-1 motion
  assert.equal(parseSgrMouse("\x1b[<35;10;5M"), null); // pure motion (no button)
});

test("[mouse-malformed] malformed input returns null", () => {
  assert.equal(parseSgrMouse(""), null);
  assert.equal(parseSgrMouse("\x1b[<64;10M"), null); // missing y
  assert.equal(parseSgrMouse("\x1b[<64;10;5"), null); // missing final byte
  assert.equal(parseSgrMouse("64;10;5M"), null); // missing CSI prefix
  assert.equal(parseSgrMouse("\x1b[<;;M"), null); // empty fields
  assert.equal(parseSgrMouse("\x1b[<64;x;5M"), null); // non-numeric
  assert.equal(parseSgrMouse("hello"), null);
});

test("[mouse-wheel-modifier] a wheel event with a modifier bit set still classifies", () => {
  // Shift adds 4, Ctrl adds 16, Meta/Alt adds 8 to the button code.
  assert.deepEqual(parseSgrMouse("\x1b[<68;10;5M"), { kind: "wheel-up", x: 10, y: 5 }); // 64|4 Shift
  assert.deepEqual(parseSgrMouse("\x1b[<80;10;5M"), { kind: "wheel-up", x: 10, y: 5 }); // 64|16 Ctrl
  assert.deepEqual(parseSgrMouse("\x1b[<69;10;5M"), { kind: "wheel-down", x: 10, y: 5 }); // 65|4 Shift
  assert.deepEqual(parseSgrMouse("\x1b[<93;10;5M"), { kind: "wheel-down", x: 10, y: 5 }); // 65|8|16+4
});

test("[mouse-disable-sequence] MOUSE_DISABLE is the documented disable sequence", () => {
  assert.equal(MOUSE_DISABLE, "\x1b[?1000l\x1b[?1002l\x1b[?1006l");
});

test("[mouse-enable-sequence] MOUSE_ENABLE turns on basic + SGR mouse tracking", () => {
  assert.equal(MOUSE_ENABLE, "\x1b[?1000h\x1b[?1006h");
});
