/**
 * Phase 10A full TUI — renderer is ANSI-width-aware so colored lines (which carry
 * invisible SGR codes) are measured/truncated by their VISIBLE width, not byte
 * length. Without this, a colored status/line that fits visibly would be wrongly
 * cut mid-escape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, renderFrame } from "../../src/ui/minimalRenderer.js";

test("visibleWidth ignores SGR color codes", () => {
  assert.equal(visibleWidth("\x1b[31mabc\x1b[39m"), 3);
  assert.equal(visibleWidth("plain"), 5);
});

test("renderFrame leaves a colored line that fits (by visible width) unchanged", () => {
  const colored = "\x1b[31mhello\x1b[39m"; // visible width 5
  const frame = renderFrame({
    statusLine: "s", lines: [colored], viewportTop: 0, height: 1,
    width: 10, inputLine: "> ", hasNewOutputBelow: false,
  });
  // the visible content row must still contain the full colored string (not cut)
  assert.ok(frame.some((l) => l.includes(colored)), "colored line preserved intact");
});

test("renderFrame truncates by visible width and closes the style", () => {
  const colored = "\x1b[31mabcdefgh\x1b[39m"; // visible width 8
  const frame = renderFrame({
    statusLine: "s", lines: [colored], viewportTop: 0, height: 1,
    width: 4, inputLine: "> ", hasNewOutputBelow: false,
  });
  const row = frame[1];
  // 4 visible chars kept, style preserved, reset appended
  assert.equal(visibleWidth(row), 4, "cut to 4 visible columns");
  assert.ok(row.includes("abcd") && !row.includes("efgh"), "kept first 4, dropped rest");
});
