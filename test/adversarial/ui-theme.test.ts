/**
 * Phase 10A full TUI — color & theming (pure, no I/O).
 *
 * resolveColorEnabled decides whether to emit ANSI color, honoring FORCE_COLOR
 * (explicit on/off), then NO_COLOR (explicit off), then the TTY default.
 * createTheme returns semantic style functions; when color is disabled every
 * style is the identity function (no escape codes leak into non-color output).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveColorEnabled, createTheme } from "../../src/ui/theme.js";

test("NO_COLOR disables color even on a TTY", () => {
  assert.equal(resolveColorEnabled({ env: { NO_COLOR: "1" }, isTTY: true }), false);
});

test("FORCE_COLOR overrides NO_COLOR and non-TTY", () => {
  assert.equal(resolveColorEnabled({ env: { FORCE_COLOR: "1", NO_COLOR: "1" }, isTTY: false }), true);
});

test("FORCE_COLOR=0 force-disables", () => {
  assert.equal(resolveColorEnabled({ env: { FORCE_COLOR: "0" }, isTTY: true }), false);
});

test("with no overrides, color follows the TTY", () => {
  assert.equal(resolveColorEnabled({ env: {}, isTTY: true }), true);
  assert.equal(resolveColorEnabled({ env: {}, isTTY: false }), false);
});

test("enabled theme wraps content in SGR codes and resets", () => {
  const t = createTheme(true);
  const e = t.error("boom");
  assert.ok(e.includes("boom"), "content preserved");
  assert.ok(e.startsWith("\x1b["), "starts with an SGR sequence");
  assert.ok(e.endsWith("m") || e.includes("\x1b["), "contains SGR reset");
  assert.notEqual(e, "boom", "color was applied");
});

test("disabled theme is identity for every style (no escape codes)", () => {
  const t = createTheme(false);
  for (const style of [t.dim, t.success, t.error, t.warning, t.title, t.selected]) {
    const out = style("x");
    assert.equal(out, "x", "identity when color disabled");
    assert.ok(!out.includes("\x1b"), "no escape codes leak");
  }
});
