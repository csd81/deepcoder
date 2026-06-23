/**
 * Phase 10A.19 — UI Polish Layer (pure module) adversarial tests.
 *
 * Covers styleTokens.ts and emptyState.ts:
 *  - StyleTokens structure, chrome symbols, role/state styling, plain mode.
 *  - Empty state: useful content, height/width bounding, no-ANSI plain mode,
 *    deterministic output.
 *
 * (The transcriptPresenter tests were removed with that now-dead module — its
 * presentation logic was refactored inline into repl.ts.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTheme } from "../../src/ui/theme.js";
import { createStyleTokens } from "../../src/ui/styleTokens.js";
import { renderEmptyState } from "../../src/ui/emptyState.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const colorTheme = createTheme(true);
const plainTheme = createTheme(false);
const colorTokens = createStyleTokens(colorTheme);
const plainTokens = createStyleTokens(plainTheme);
const WIDE = 200;

// ═════════════════════════════════════════════════════════════════════════════
//  1. StyleTokens
// ═════════════════════════════════════════════════════════════════════════════

test("[styleTokens-structure] createStyleTokens returns all expected sections", () => {
  const t = createStyleTokens(colorTheme);
  // role section
  assert.equal(typeof t.role.user, "function");
  assert.equal(typeof t.role.assistant, "function");
  assert.equal(typeof t.role.system, "function");
  assert.equal(typeof t.role.tool, "function");
  assert.equal(typeof t.role.check, "function");
  assert.equal(typeof t.role.worker, "function");

  // state section
  assert.equal(typeof t.state.success, "function");
  assert.equal(typeof t.state.error, "function");
  assert.equal(typeof t.state.warning, "function");
  assert.equal(typeof t.state.running, "function");
  assert.equal(typeof t.state.muted, "function");
  assert.equal(typeof t.state.selected, "function");

  // chrome section
  assert.equal(typeof t.chrome.separator, "string");
  assert.equal(typeof t.chrome.bulletCollapsed, "string");
  assert.equal(typeof t.chrome.bulletExpanded, "string");
  assert.equal(typeof t.chrome.checkPass, "string");
  assert.equal(typeof t.chrome.checkFail, "string");
});

test("[styleTokens-chrome-symbols] chrome symbols are the expected Unicode characters", () => {
  const t = createStyleTokens(colorTheme);
  assert.equal(t.chrome.separator, "─");
  assert.equal(t.chrome.bulletCollapsed, "▸");
  assert.equal(t.chrome.bulletExpanded, "▾");
  assert.equal(t.chrome.checkPass, "✓");
  assert.equal(t.chrome.checkFail, "✗");
});

test("[styleTokens-role-styles] role functions apply correct theme styles (color enabled)", () => {
  const t = createStyleTokens(colorTheme);
  // user/assistant → bold (via theme.title: SGR 1)
  assert.ok(t.role.user("You").startsWith("\x1b[1m"), "user header is bold");
  assert.ok(t.role.assistant("Deepcoder").startsWith("\x1b[1m"), "assistant header is bold");

  // system/tool/check/worker → dim, now a readable grey truecolor (not faint SGR 2)
  assert.ok(t.role.system("System").startsWith("\x1b[38;2;"), "system header is grey (not faint)");
  assert.ok(t.role.tool("tool x").startsWith("\x1b[38;2;"), "tool header is grey (not faint)");
  assert.ok(t.role.check("check y").startsWith("\x1b[38;2;"), "check header is grey (not faint)");
  assert.ok(t.role.worker("worker z").startsWith("\x1b[38;2;"), "worker header is grey (not faint)");

  // Content preserved inside the escape codes
  assert.ok(t.role.user("You").includes("You"), "content preserved in role styling");
});

test("[styleTokens-state-styles] state functions apply correct theme styles (color enabled)", () => {
  const t = createStyleTokens(colorTheme);

  // success/error/warning → bold + darker truecolor (legible on a pale background)
  assert.ok(t.state.success("ok").includes("\x1b[1;38;2;"), "success is bold truecolor green");
  assert.ok(t.state.error("fail").includes("\x1b[1;38;2;"), "error is bold truecolor red");
  assert.ok(t.state.warning("warn").includes("\x1b[1;38;2;"), "warning is bold truecolor amber");
  // running → SGR 1 (bold, via theme.title)
  assert.ok(t.state.running("run").includes("\x1b[1m"), "running uses bold");
  // muted → dim, now a readable grey truecolor (not faint SGR 2)
  assert.ok(t.state.muted("mute").includes("\x1b[38;2;"), "muted is grey (not faint)");
  // selected → SGR 7 (invert)
  assert.ok(t.state.selected("sel").includes("\x1b[7m"), "selected uses invert");
});

test("[styleTokens-plain] plain/no-color tokens produce no ANSI escape codes", () => {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[/;
  const t = createStyleTokens(plainTheme);

  for (const fn of [
    t.role.user, t.role.assistant, t.role.system,
    t.role.tool, t.role.check, t.role.worker,
    t.state.success, t.state.error, t.state.warning,
    t.state.running, t.state.muted, t.state.selected,
  ]) {
    const out = fn("test");
    assert.doesNotMatch(out, ansi, `identity style for plain tokens: ${out}`);
    assert.equal(out, "test", "identity preserves content");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. Empty State
// ═════════════════════════════════════════════════════════════════════════════

test("[emptyState-renders] empty state renders with useful content", () => {
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: plainTokens });

  assert.ok(lines.length > 0, "empty state has lines");
  assert.ok(lines.some((l) => l.includes("Deepcoder")), "contains Deepcoder header");
  assert.ok(
    lines.some((l) => l.includes("/doctor")),
    "contains /doctor suggestion",
  );
  assert.ok(
    lines.some((l) => l.includes("commands")),
    "contains instructional text",
  );
});

test("[emptyState-bounded-height] empty state is bounded by height", () => {
  const linesShort = renderEmptyState({ width: WIDE, height: 3, tokens: plainTokens });
  assert.ok(linesShort.length <= 3, `height=3 yields ≤3 lines (got ${linesShort.length})`);

  const linesTall = renderEmptyState({ width: WIDE, height: 30, tokens: plainTokens });
  assert.ok(linesTall.length <= 30, `height=30 yields ≤30 lines`);
  // Taller height should include more commands
  assert.ok(linesTall.length > linesShort.length, "taller height shows more content");
});

test("[emptyState-min-height] empty state returns empty array when height too small", () => {
  const lines = renderEmptyState({ width: WIDE, height: 1, tokens: plainTokens });
  assert.equal(lines.length, 0, "height=1 returns no lines");
});

test("[emptyState-width-bounded] each line is truncated to width", () => {
  for (const w of [80, 40, 20, 10]) {
    const lines = renderEmptyState({ width: w, height: 10, tokens: plainTokens });
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= w, `width=${w} visibleWidth=${visibleWidth(line)}: "${line}"`);
    }
  }
});

test("[emptyState-no-ansi] plain tokens produce no escape codes in empty state", () => {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[/;
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: plainTokens });
  for (const line of lines) {
    assert.doesNotMatch(line, ansi, `no ANSI in plain empty state: "${line}"`);
  }
});

test("[emptyState-color] color tokens produce ANSI codes in empty state", () => {
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: colorTokens });
  const all = lines.join("");
  // At least the header (Deepcoder → bold) should have ANSI
  assert.ok(all.includes("\x1b["), "color empty state includes ANSI codes");
});

test("[emptyState-deterministic] same inputs produce identical output", () => {
  const a = renderEmptyState({ width: 80, height: 15, tokens: plainTokens });
  const b = renderEmptyState({ width: 80, height: 15, tokens: plainTokens });
  assert.deepEqual(a, b);
});
