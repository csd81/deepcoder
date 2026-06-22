/**
 * Phase 10A.7 Slice 4/6 — pure status bar renderer.
 * Compact operational state, every segment degrading gracefully when absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusBar, type StatusBarInfo } from "../../src/ui/statusBar.js";
import { createTheme } from "../../src/ui/theme.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";

const theme = createTheme(true);
const plain = createTheme(false);

const FULL: StatusBarInfo = {
  mode: "auto",
  provider: "openrouter",
  model: "openai/gpt-oss-20b:free",
  sandbox: "fast",
  web: false,
  branch: "master",
  dirty: true,
  tokens: 42000,
  costUsd: 0.0345,
  workers: 2,
  busy: true,
};

test("full info renders every segment", () => {
  const s = renderStatusBar(FULL, 200, theme);
  assert.match(s, /deepcoder/);
  assert.match(s, /auto/);
  assert.match(s, /openrouter\/openai\/gpt-oss-20b:free/);
  assert.match(s, /sandbox fast/);
  assert.match(s, /web off/);
  assert.match(s, /master\*/); // dirty marker
  assert.match(s, /42k/); // tokens
  assert.match(s, /\$0\.03/); // cost
  assert.match(s, /2 workers/);
  assert.match(s, /running/);
});

test("web on/off reflects the flag", () => {
  assert.match(renderStatusBar({ ...FULL, web: true }, 200, theme), /web on/);
  assert.match(renderStatusBar({ ...FULL, web: false }, 200, theme), /web off/);
});

test("idle when not busy; clean branch has no asterisk", () => {
  const s = renderStatusBar({ ...FULL, busy: false, dirty: false }, 200, theme);
  assert.match(s, /idle/);
  assert.match(s, /master/);
  assert.doesNotMatch(s, /master\*/);
});

test("minimal info degrades gracefully — no undefined, no dangling separators", () => {
  const min: StatusBarInfo = {
    mode: "ask",
    provider: "deepseek",
    model: "deepseek-chat",
    sandbox: "off",
    web: false,
    busy: false,
  };
  const s = renderStatusBar(min, 200, plain);
  assert.doesNotMatch(s, /undefined/);
  assert.doesNotMatch(s, /NaN/);
  assert.doesNotMatch(s, /· *·/); // no empty segment between separators
  assert.doesNotMatch(s, /workers/); // omitted when absent
  assert.doesNotMatch(s, /\$/); // no cost when absent
});

test("zero workers are omitted", () => {
  assert.doesNotMatch(renderStatusBar({ ...FULL, workers: 0 }, 200, theme), /workers/);
});

test("output is truncated to width (visibleWidth-aware)", () => {
  for (const w of [80, 40, 20, 10]) {
    const s = renderStatusBar(FULL, w, theme);
    assert.ok(visibleWidth(s) <= w, `width ${w}: got ${visibleWidth(s)}`);
  }
});

test("createTheme(false) produces no SGR escape codes", () => {
  const s = renderStatusBar(FULL, 200, plain);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(s, /\x1b\[/);
});
