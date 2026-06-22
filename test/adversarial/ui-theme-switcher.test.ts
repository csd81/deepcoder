/**
 * Phase 10A.18 — Color Theme Switcher: named palettes & env resolution.
 *
 * Tests for the pure module src/ui/themes.ts. Verifies:
 *  - Built-in palettes are complete and expose every semantic style.
 *  - `createNamedTheme` wraps content in correct SGR codes.
 *  - `createNamedTheme(_, false)` is identity (no ANSI).
 *  - Unknown theme names throw (createNamedTheme) or fall back with warning
 *    (resolveThemeFromEnv).
 *  - Env resolution honours DEEPCODER_UI_COLOR, FORCE_COLOR, NO_COLOR, TTY.
 *  - Monochrome palette uses no hue codes.
 *  - `resolveThemeFromEnv` respects runtime themeName override.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTheme } from "../../src/ui/theme.js";
import {
  BUILTIN_PALETTES,
  listThemeNames,
  isValidThemeName,
  createNamedTheme,
  resolveThemeFromEnv,
  type ThemeName,
} from "../../src/ui/themes.js";

// ---------------------------------------------------------------------------
// Palette completeness
// ---------------------------------------------------------------------------

test("BUILTIN_PALETTES contains all four named themes", () => {
  const names = listThemeNames();
  assert.deepEqual(names.sort(), ["default", "high-contrast", "monochrome", "muted"]);
});

test("every built-in theme exposes all six semantic style slots", () => {
  const slots: Array<keyof typeof BUILTIN_PALETTES["default"] & string> = [
    "name",
    "dim",
    "success",
    "error",
    "warning",
    "title",
    "selected",
  ];
  for (const name of listThemeNames()) {
    const p = BUILTIN_PALETTES[name];
    for (const slot of slots) {
      assert.ok(slot in p, `${name}.${slot} exists`);
    }
  }
});

test("isValidThemeName returns true for built-ins and false for unknown", () => {
  for (const name of listThemeNames()) {
    assert.equal(isValidThemeName(name), true);
  }
  assert.equal(isValidThemeName("nope"), false);
  assert.equal(isValidThemeName("solarized-dark"), false);
  assert.equal(isValidThemeName(""), false);
});

// ---------------------------------------------------------------------------
// createNamedTheme – color enabled
// ---------------------------------------------------------------------------

test('createNamedTheme("default", true) matches createTheme(true) from theme.ts', () => {
  const existing = createTheme(true);
  const named = createNamedTheme("default", true);

  const inputs = ["hello", "", "multi\nline"];
  const slots: Array<keyof typeof existing> = ["dim", "success", "error", "warning", "title", "selected"];

  for (const slot of slots) {
    for (const input of inputs) {
      assert.equal(named[slot](input), existing[slot](input), `${slot}("${input}") matches`);
    }
  }
});

test("createNamedTheme with color=true wraps content in SGR codes", () => {
  const t = createNamedTheme("default", true);
  const e = t.error("boom");
  assert.ok(e.includes("boom"), "content preserved");
  assert.ok(e.startsWith("\x1b["), "starts with an SGR sequence");
  assert.ok(e.endsWith("m"), "ends with SGR reset");
  assert.notEqual(e, "boom", "color was applied");
});

test("createNamedTheme with color=false is identity for every style (no escape codes)", () => {
  const t = createNamedTheme("default", false);
  for (const style of [t.dim, t.success, t.error, t.warning, t.title, t.selected]) {
    const out = style("x");
    assert.equal(out, "x", "identity when color disabled");
    assert.ok(!out.includes("\x1b"), "no escape codes leak");
  }
});

// ---------------------------------------------------------------------------
// Unknown theme name handling
// ---------------------------------------------------------------------------

test("createNamedTheme with unknown name throws", () => {
  assert.throws(
    () => (createNamedTheme as (n: string, c: boolean) => unknown)("nope" as ThemeName, true),
    /Unknown theme/,
  );
});

test("resolveThemeFromEnv with unknown DEEPCODER_THEME falls back with warning", () => {
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_THEME: "solarized" },
    isTTY: true,
  });
  assert.equal(result.themeName, "default");
  assert.equal(result.color, true);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings[0].includes("solarized"));
});

// ---------------------------------------------------------------------------
// NO_COLOR / FORCE_COLOR / DEEPCODER_UI_COLOR
// ---------------------------------------------------------------------------

test("NO_COLOR disables ANSI even with a theme set", () => {
  const result = resolveThemeFromEnv({
    env: { NO_COLOR: "1", DEEPCODER_THEME: "high-contrast" },
    isTTY: true,
  });
  assert.equal(result.color, false);
  assert.equal(result.themeName, "high-contrast"); // theme still selected even if color off
});

test("FORCE_COLOR=1 enables ANSI in non-TTY", () => {
  const result = resolveThemeFromEnv({
    env: { FORCE_COLOR: "1" },
    isTTY: false,
  });
  assert.equal(result.color, true);
});

test("FORCE_COLOR=0 force-disables", () => {
  const result = resolveThemeFromEnv({
    env: { FORCE_COLOR: "0" },
    isTTY: true,
  });
  assert.equal(result.color, false);
});

test("DEEPCODER_UI_COLOR=off wins over FORCE_COLOR", () => {
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_UI_COLOR: "off", FORCE_COLOR: "1" },
    isTTY: true,
  });
  assert.equal(result.color, false);
});

test("DEEPCODER_UI_COLOR=on enables ANSI in non-TTY even without FORCE_COLOR", () => {
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_UI_COLOR: "on" },
    isTTY: false,
  });
  assert.equal(result.color, true);
});

test("DEEPCODER_UI_COLOR=on respects NO_COLOR override", () => {
  // per the plan: "DEEPCODER_UI_COLOR=on enables ANSI unless NO_COLOR policy
  // is intentionally stronger". Here NO_COLOR is set, so it wins.
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_UI_COLOR: "on", NO_COLOR: "1" },
    isTTY: false,
  });
  assert.equal(result.color, false);
});

test("with no overrides, color follows the TTY", () => {
  const onTTY = resolveThemeFromEnv({ env: {}, isTTY: true });
  assert.equal(onTTY.color, true);

  const notTTY = resolveThemeFromEnv({ env: {}, isTTY: false });
  assert.equal(notTTY.color, false);
});

// ---------------------------------------------------------------------------
// Theme resolution respects runtime override
// ---------------------------------------------------------------------------

test("resolveThemeFromEnv uses runtime themeName over DEEPCODER_THEME", () => {
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_THEME: "high-contrast" },
    isTTY: true,
    themeName: "muted",
  });
  assert.equal(result.themeName, "muted");
});

test("resolveThemeFromEnv uses runtime colorMode over DEEPCODER_UI_COLOR", () => {
  const result = resolveThemeFromEnv({
    env: { DEEPCODER_UI_COLOR: "on" },
    isTTY: false,
    colorMode: "off",
  });
  assert.equal(result.color, false);
  assert.equal(result.colorMode, "off");
});

// ---------------------------------------------------------------------------
// Each built-in theme has distinct behavior
// ---------------------------------------------------------------------------

test("high-contrast uses bright color codes", () => {
  const t = createNamedTheme("high-contrast", true);
  // Bright red
  assert.ok(t.error("x").includes("91"), "high-contrast error uses bright red (91)");
  // Bright green
  assert.ok(t.success("x").includes("92"), "high-contrast success uses bright green (92)");
  // Bright yellow
  assert.ok(t.warning("x").includes("93"), "high-contrast warning uses bright yellow (93)");
  // Grey dim
  assert.ok(t.dim("x").includes("90"), "high-contrast dim uses grey (90)");
});

test("monochrome uses only style codes, no hue codes", () => {
  const t = createNamedTheme("monochrome", true);

  // All SGR codes in monochrome output should be non-color codes:
  // 1 (bold), 2 (faint), 7 (reverse), 22 (bold off), 27 (reverse off)
  // No 3x, 4x, 9x codes (color codes)
  for (const slot of ["dim", "success", "error", "warning", "title", "selected"] as const) {
    const output = t[slot]("test");
    // Should contain SGR codes
    assert.ok(output.includes("\x1b["), `${slot} uses SGR`);
    // Should NOT contain hue codes (3x, 4x, 9x are color codes)
    // Bold is 1, faint is 2, reverse is 7, off codes are 22, 27, 39
    // Strike: 9 is not a standalone code, 9x are bright colors
    // Let's check the parameter values in the output
    const codes = output.match(/\x1b\[(\d+)m/g);
    if (codes) {
      for (const code of codes) {
        const num = parseInt(code.slice(2, -1), 10);
        // Hue codes are in ranges: 30-37, 38, 39, 40-47, 48, 49, 90-97
        // Non-hue (style) codes: 1, 2, 7, 22, 27
        const isHue = (num >= 30 && num <= 49) || (num >= 90 && num <= 97);
        assert.equal(isHue, false, `monochrome ${slot} has no hue code ${num}`);
      }
    }
  }
});

test("default theme uses standard color codes", () => {
  const t = createNamedTheme("default", true);
  assert.ok(t.error("x").includes("31"), "default error uses red (31)");
  assert.ok(t.success("x").includes("32"), "default success uses green (32)");
  assert.ok(t.warning("x").includes("33"), "default warning uses yellow (33)");
  assert.ok(t.dim("x").includes("2"), "default dim uses faint (2)");
});

test("muted theme uses standard (non-bright) color codes", () => {
  const t = createNamedTheme("muted", true);
  // Muted should use regular colors, not bright
  assert.ok(t.error("x").includes("31"), "muted error uses red (31)");
  assert.ok(t.success("x").includes("32"), "muted success uses green (32)");
  assert.ok(t.warning("x").includes("33"), "muted warning uses yellow (33)");
  assert.ok(t.dim("x").includes("2"), "muted dim uses faint (2)");
});

// ---------------------------------------------------------------------------
// resolveThemeFromEnv returns correct colorMode
// ---------------------------------------------------------------------------

test("resolveThemeFromEnv reports colorMode=auto when no override", () => {
  const result = resolveThemeFromEnv({ env: {}, isTTY: true });
  assert.equal(result.colorMode, "auto");
});

test("resolveThemeFromEnv reports explicit colorMode", () => {
  const off = resolveThemeFromEnv({ env: { DEEPCODER_UI_COLOR: "off" }, isTTY: true });
  assert.equal(off.colorMode, "off");

  const on = resolveThemeFromEnv({ env: { DEEPCODER_UI_COLOR: "on" }, isTTY: false });
  assert.equal(on.colorMode, "on");

  const auto = resolveThemeFromEnv({ env: { DEEPCODER_UI_COLOR: "auto" }, isTTY: false });
  assert.equal(auto.colorMode, "auto");
});

// ---------------------------------------------------------------------------
// ResolvedThemeChoice shape
// ---------------------------------------------------------------------------

test("ResolvedThemeChoice has all expected fields", () => {
  const r = resolveThemeFromEnv({ env: {}, isTTY: true });
  assert.equal(typeof r.color, "boolean");
  assert.equal(typeof r.themeName, "string");
  assert.equal(typeof r.colorMode, "string");
  assert.ok(Array.isArray(r.warnings));
});
