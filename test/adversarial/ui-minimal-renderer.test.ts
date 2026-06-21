/**
 * Phase 10A (slice 3) — minimal renderer tests.
 *
 * Tests the pure frame builder and key mapping:
 *   - renderFrame: status bar is first line; visible window sliced by
 *     viewportTop/height; "new output below" indicator only when
 *     hasNewOutputBelow; every line truncated to width; input line is last.
 *   - keyToAction: pageup→scroll-up, pagedown→scroll-down, Ctrl+u→half-up,
 *     Ctrl+d→half-down, home→top, end→bottom, escape→escape, enter→submit,
 *     Ctrl+C→interrupt, other→none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFrame, keyToAction } from "../../src/ui/minimalRenderer.js";
import type { FrameInput } from "../../src/ui/minimalRenderer.js";

// ── renderFrame ──────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<FrameInput>): FrameInput {
  return {
    statusLine: "status: auto · branch main",
    lines: [
      "line 0",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
    ],
    viewportTop: 0,
    height: 5,
    width: 80,
    inputLine: "> ",
    hasNewOutputBelow: false,
    ...overrides,
  };
}

test("[render-status-bar-first] renderFrame: status bar is the first line", () => {
  const frame = renderFrame(makeInput());
  assert.equal(frame[0], "status: auto · branch main");
});

test("[render-visible-window] renderFrame: visible window is sliced by viewportTop and height", () => {
  const frame = renderFrame(makeInput({ viewportTop: 3, height: 3 }));
  // frame[0] = status, frame[1..3] = visible window, frame[4] = input
  assert.equal(frame[1], "line 3");
  assert.equal(frame[2], "line 4");
  assert.equal(frame[3], "line 5");
  assert.equal(frame.length, 5); // status + 3 visible + input
});

test("[render-new-output-indicator] renderFrame: 'new output below' indicator appears only when hasNewOutputBelow", () => {
  // Without indicator
  const frameWithout = renderFrame(makeInput({ hasNewOutputBelow: false, height: 2 }));
  // frame: [status, line0, line1, input] = 4 lines
  assert.equal(frameWithout.length, 4);
  assert.equal(frameWithout[frameWithout.length - 1], "> ");

  // With indicator
  const frameWith = renderFrame(makeInput({ hasNewOutputBelow: true, height: 2 }));
  // frame: [status, line0, line1, "↓ new output below", input] = 5 lines
  assert.equal(frameWith.length, 5);
  assert.equal(frameWith[3], "↓ new output below");
  assert.equal(frameWith[4], "> ");
});

test("[render-truncation] renderFrame: every line is truncated to width", () => {
  const longLine = "a".repeat(200);
  const frame = renderFrame(
    makeInput({
      statusLine: longLine,
      lines: [longLine],
      viewportTop: 0,
      height: 1,
      width: 10,
      inputLine: longLine,
    }),
  );
  // frame[0] = status truncated to 10
  assert.equal(frame[0].length, 10);
  assert.equal(frame[0], "a".repeat(10));
  // frame[1] = visible line truncated to 10
  assert.equal(frame[1].length, 10);
  // frame[2] = input truncated to 10
  assert.equal(frame[2].length, 10);
});

test("[render-input-line-last] renderFrame: input line is the last line", () => {
  const frame = renderFrame(makeInput({ inputLine: "> hello", height: 2 }));
  assert.equal(frame[frame.length - 1], "> hello");
});

test("[render-padding] renderFrame: pads remaining rows when fewer lines than height", () => {
  const frame = renderFrame(
    makeInput({
      lines: ["only one"],
      viewportTop: 0,
      height: 5,
    }),
  );
  // frame[0] = status, frame[1] = "only one", frame[2..5] = empty padding, frame[6] = input
  assert.equal(frame.length, 7); // status + 5 height + input
  assert.equal(frame[1], "only one");
  assert.equal(frame[2], "");
  assert.equal(frame[3], "");
  assert.equal(frame[4], "");
  assert.equal(frame[5], "");
  assert.equal(frame[6], "> ");
});

test("[render-empty-lines] renderFrame: handles empty lines array", () => {
  const frame = renderFrame(
    makeInput({
      lines: [],
      viewportTop: 0,
      height: 3,
    }),
  );
  // frame[0] = status, frame[1..3] = empty padding, frame[4] = input
  assert.equal(frame.length, 5);
  assert.equal(frame[1], "");
  assert.equal(frame[2], "");
  assert.equal(frame[3], "");
  assert.equal(frame[4], "> ");
});

// ── keyToAction ──────────────────────────────────────────────────────────────

test("[key-pageup] keyToAction: pageup → scroll-up", () => {
  assert.equal(keyToAction("pageup"), "scroll-up");
});

test("[key-pagedown] keyToAction: pagedown → scroll-down", () => {
  assert.equal(keyToAction("pagedown"), "scroll-down");
});

test("[key-ctrl-u] keyToAction: Ctrl+U (\\x15) → half-up", () => {
  assert.equal(keyToAction("\x15"), "half-up");
});

test("[key-ctrl-d] keyToAction: Ctrl+D (\\x04) → half-down", () => {
  assert.equal(keyToAction("\x04"), "half-down");
});

test("[key-home] keyToAction: home → top", () => {
  assert.equal(keyToAction("home"), "top");
});

test("[key-end] keyToAction: end → bottom", () => {
  assert.equal(keyToAction("end"), "bottom");
});

test("[key-escape] keyToAction: escape → escape", () => {
  assert.equal(keyToAction("escape"), "escape");
});

test("[key-escape-raw] keyToAction: raw escape (\\x1b) → escape", () => {
  assert.equal(keyToAction("\x1b"), "escape");
});

test("[key-enter] keyToAction: enter → submit", () => {
  assert.equal(keyToAction("enter"), "submit");
});

test("[key-return] keyToAction: return → submit", () => {
  assert.equal(keyToAction("return"), "submit");
});

test("[key-enter-raw] keyToAction: \\r → submit", () => {
  assert.equal(keyToAction("\r"), "submit");
});

test("[key-enter-newline] keyToAction: \\n → submit", () => {
  assert.equal(keyToAction("\n"), "submit");
});

test("[key-ctrl-c] keyToAction: Ctrl+C (\\x03) → interrupt", () => {
  assert.equal(keyToAction("\x03"), "interrupt");
});

test("[key-other] keyToAction: any other key → none", () => {
  assert.equal(keyToAction("a"), "none");
  assert.equal(keyToAction(" "), "none");
  assert.equal(keyToAction("F1"), "none");
  assert.equal(keyToAction(""), "none");
});

test("[key-raw-escape-sequences] keyToAction: raw escape sequences map correctly", () => {
  assert.equal(keyToAction("\u001b[5~"), "scroll-up");
  assert.equal(keyToAction("\u001b[6~"), "scroll-down");
  assert.equal(keyToAction("\u001b[H"), "top");
  assert.equal(keyToAction("\u001b[F"), "bottom");
  assert.equal(keyToAction("\u001b[1~"), "top");
  assert.equal(keyToAction("\u001b[4~"), "bottom");
});
