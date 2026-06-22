import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusBar, type StatusBarInfo } from "../src/ui/statusBar.js";
import { createTheme } from "../src/ui/theme.js";

// Red-seed anchor (do NOT weaken). renderStatusBar gains an optional `fields`
// param selecting + ordering segments. Pure function — no I/O. Plain theme so
// assertions are clean strings.

const theme = createTheme(false); // identity (no ANSI)
const info: StatusBarInfo = {
  mode: "auto",
  provider: "deepseek",
  model: "deepseek-v4",
  sandbox: "fast",
  web: false,
  busy: false,
};

test('fields ["title","busy"] renders only those, in order', () => {
  assert.equal(renderStatusBar(info, 200, theme, ["title", "busy"]), "deepcoder · idle");
});

test("an explicit single field excludes everything else", () => {
  const out = renderStatusBar(info, 200, theme, ["mode"]);
  assert.ok(out.includes("auto"), "mode shown");
  assert.ok(!out.includes("deepseek-v4"), "model NOT shown");
});

test("an empty field list renders an empty string", () => {
  assert.equal(renderStatusBar(info, 200, theme, []), "");
});

test("no fields argument preserves the current default (model + mode present)", () => {
  const out = renderStatusBar(info, 200, theme);
  assert.ok(out.includes("deepseek-v4"), "default still shows the model");
  assert.ok(out.includes("auto"), "default still shows the mode");
});
