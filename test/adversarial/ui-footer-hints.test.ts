/**
 * Phase 10A.17 Slice B — pure footer hints renderer.
 * Contextual keyboard hints per UI mode, width-bounded, no raw I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFooterHints, type FooterHintMode } from "../../src/ui/footerHints.js";
import { createTheme } from "../../src/ui/theme.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";

const theme = createTheme(true);
const plain = createTheme(false);
const WIDTH = 200;

// ── Normal mode ─────────────────────────────────────────────────────────────

test("[footerhints-normal] normal hints include send/slash/search/help", () => {
  const s = renderFooterHints({ mode: "normal", width: WIDTH, theme });
  assert.match(s, /Enter send/);
  assert.match(s, /\/ commands/);
  assert.match(s, /Ctrl\+F search/);
  assert.match(s, /\? help/);
});

// ── Busy mode ───────────────────────────────────────────────────────────────

test("[footerhints-busy] busy hints include interrupt", () => {
  const s = renderFooterHints({ mode: "busy", width: WIDTH, theme });
  assert.match(s, /PgUp\/PgDn scroll/);
  assert.match(s, /Tab inspect/);
  assert.match(s, /Ctrl\+C interrupt/);
  assert.match(s, /\? help/);
});

// ── Slash menu mode ─────────────────────────────────────────────────────────

test("[footerhints-slash] slash-menu hints include select/complete/run/close", () => {
  const s = renderFooterHints({ mode: "slash-menu", width: WIDTH, theme });
  assert.match(s, /↑↓ select/);
  assert.match(s, /Tab complete/);
  assert.match(s, /Enter run/);
  assert.match(s, /Esc close/);
});

// ── Search mode ─────────────────────────────────────────────────────────────

test("[footerhints-search] search hints include next/previous/scroll/close", () => {
  const s = renderFooterHints({ mode: "search", width: WIDTH, theme });
  assert.match(s, /Enter\/n next/);
  assert.match(s, /p previous/);
  assert.match(s, /PgUp\/PgDn scroll/);
  assert.match(s, /Esc close/);
});

// ── Focused block mode ──────────────────────────────────────────────────────

test("[footerhints-focused-block] focused-block hints include expand/copy/save", () => {
  const s = renderFooterHints({ mode: "focused-block", width: WIDTH, theme });
  assert.match(s, /Enter expand/);
  assert.match(s, /y copy/);
  assert.match(s, /s save/);
  assert.match(s, /Tab next/);
  assert.match(s, /Esc clear/);
});

// ── Approval mode ───────────────────────────────────────────────────────────

test("[footerhints-approval] approval hints include approve/deny/scroll", () => {
  const s = renderFooterHints({ mode: "approval", width: WIDTH, theme });
  assert.match(s, /y approve/);
  assert.match(s, /n deny/);
  assert.match(s, /↑↓ scroll/);
  assert.match(s, /Esc deny/);
});

// ── Width bounding ──────────────────────────────────────────────────────────

test("[footerhints-width] output is truncated to width (visibleWidth-aware)", () => {
  for (const mode of ["normal", "busy", "slash-menu", "search", "focused-block", "approval"] as FooterHintMode[]) {
    for (const w of [80, 40, 20, 10]) {
      const s = renderFooterHints({ mode, width: w, theme });
      assert.ok(visibleWidth(s) <= w, `mode=${mode} width=${w}: got visibleWidth=${visibleWidth(s)}`);
    }
  }
});

// ── Plain theme (no ANSI) ───────────────────────────────────────────────────

test("[footerhints-plain] no-color theme produces no SGR escape codes", () => {
  for (const mode of ["normal", "busy", "slash-menu", "search", "focused-block", "approval"] as FooterHintMode[]) {
    const s = renderFooterHints({ mode, width: 200, theme: plain });
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(s, /\x1b\[/);
  }
});

// ── No undefined / no truncation when width is ample ────────────────────────

test("[footerhints-full] normal hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "normal", width: 200, theme: plain });
  assert.equal(s, "Enter send · / commands · Ctrl+F search · Tab blocks · ? help");
});

test("[footerhints-busy-full] busy hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "busy", width: 200, theme: plain });
  assert.equal(s, "PgUp/PgDn scroll · Tab inspect · Ctrl+C interrupt · ? help");
});

test("[footerhints-slash-full] slash-menu hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "slash-menu", width: 200, theme: plain });
  assert.equal(s, "↑↓ select · Tab complete · Enter run · Esc close");
});

test("[footerhints-search-full] search hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "search", width: 200, theme: plain });
  assert.equal(s, "Enter/n next · p previous · PgUp/PgDn scroll · Esc close");
});

test("[footerhints-focused-full] focused-block hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "focused-block", width: 200, theme: plain });
  assert.equal(s, "Enter expand · y copy · s save · Tab next · Esc clear");
});

test("[footerhints-approval-full] approval hints contain all expected segments when unconstrained", () => {
  const s = renderFooterHints({ mode: "approval", width: 200, theme: plain });
  assert.equal(s, "y approve · n deny · ↑↓ scroll · Esc deny");
});
