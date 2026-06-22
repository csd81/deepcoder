/**
 * Phase 10A.13 — contextual TUI help overlay (pure module, no I/O).
 *
 * Tests the mode-specific entry selection and bounded-box renderer. Every test
 * calls the exported functions directly with assertions; nothing is mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  helpEntriesForMode,
  renderHelpOverlay,
  type HelpMode,
} from "../../src/ui/helpOverlay.js";
import { createTheme } from "../../src/ui/theme.js";

const SGR = /\x1b\[[0-9;]*m/g;
const plain = createTheme(false);
const color = createTheme(true);

// ── helpEntriesForMode ───────────────────────────────────────────────────

test("normal mode entries include submit, slash commands, scroll, help", () => {
  const entries = helpEntriesForMode("normal");
  const l = entries.map((e) => e.label);
  assert.ok(l.some((x) => x.includes("submit")));
  assert.ok(l.some((x) => x.includes("slash")));
  assert.ok(l.some((x) => x.includes("scroll")));
  assert.ok(l.some((x) => x === "help"));
  assert.ok(entries.some((e) => e.keys === "Enter"));
  assert.ok(entries.some((e) => e.keys === "Ctrl+C"));
});

test("focused-block entries include copy, save, expand/collapse", () => {
  const entries = helpEntriesForMode("focused-block");
  const l = entries.map((e) => e.label);
  assert.ok(l.some((x) => x.includes("copy")));
  assert.ok(l.some((x) => x.includes("save")));
  assert.ok(l.some((x) => x.includes("expand")));
  assert.equal(entries.length, 6);
});

test("slash-menu entries include select, complete, close", () => {
  const entries = helpEntriesForMode("slash-menu");
  const l = entries.map((e) => e.label);
  assert.ok(l.some((x) => x.includes("select")));
  assert.ok(l.some((x) => x.includes("complete")));
  assert.ok(l.some((x) => x.includes("close")));
});

test("search entries include next, previous, close", () => {
  const entries = helpEntriesForMode("search");
  const l = entries.map((e) => e.label);
  assert.ok(l.some((x) => x.includes("next")));
  assert.ok(l.some((x) => x.includes("previous")));
  assert.ok(l.some((x) => x.includes("close")));
});

test("approval entries include approve, deny, scroll", () => {
  const entries = helpEntriesForMode("approval");
  const l = entries.map((e) => e.label);
  assert.ok(l.some((x) => x.includes("approve")));
  assert.ok(l.some((x) => x.includes("deny")));
  assert.ok(l.some((x) => x.includes("scroll")));
  assert.ok(entries.some((e) => e.keys === "y"));
  assert.ok(entries.some((e) => e.keys === "n"));
});

test("busy entries include interrupt", () => {
  const entries = helpEntriesForMode("busy");
  assert.ok(entries.some((e) => e.label.includes("interrupt")));
});

test("all six modes return a non-empty entries array", () => {
  for (const m of ["normal", "busy", "focused-block", "slash-menu", "search", "approval"]) {
    const entries = helpEntriesForMode(m as HelpMode);
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length > 0);
    for (const e of entries) {
      assert.equal(typeof e.keys, "string");
      assert.equal(typeof e.label, "string");
      assert.ok(e.keys.length > 0);
      assert.ok(e.label.length > 0);
    }
  }
});

// ── renderHelpOverlay: dimensions ────────────────────────────────────────

test("render output is bounded by width and height", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 40, height: 10, color: false }, plain);
  assert.ok(rows.length <= 10);
  for (const r of rows) assert.ok(visWidth(r) <= 40);
});

test("render output with color is bounded", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 50, height: 12, color: true }, color);
  assert.ok(rows.length <= 12);
  for (const r of rows) assert.ok(visWidth(r) <= 50);
});

test("narrow width does not throw", () => {
  for (const w of [1, 2, 5, 10]) {
    const rows = renderHelpOverlay({ mode: "search", width: w, height: 6, color: false }, plain);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length <= 6);
  }
});

test("tiny height does not throw", () => {
  for (const h of [1, 2, 3]) {
    const rows = renderHelpOverlay({ mode: "normal", width: 40, height: h, color: false }, plain);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length <= h);
  }
});

// ── ANSI ─────────────────────────────────────────────────────────────────

test("no-color output has no ANSI", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 50, height: 14, color: false }, plain);
  assert.ok(!SGR.test(rows.join("\n")));
});

test("color output has ANSI", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 50, height: 14, color: true }, color);
  assert.ok(SGR.test(rows.join("\n")));
});

// ── Content ──────────────────────────────────────────────────────────────

test("render shows mode name in title", () => {
  for (const m of ["normal", "busy", "focused-block", "slash-menu", "search", "approval"]) {
    const rows = renderHelpOverlay({ mode: m as HelpMode, width: 40, height: 8, color: false }, plain);
    assert.ok(rows.join("\n").includes(m));
  }
});

test("custom title overrides default", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 40, height: 8, color: false, title: " My Title " }, plain);
  assert.ok(rows.join("\n").includes("My Title"));
});

test("footer shows Esc close", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 40, height: 10, color: false }, plain);
  const last = rows[rows.length - 1];
  assert.ok(last.includes("Esc"));
  assert.ok(last.includes("close"));
});

test("all six modes have Esc close footer", () => {
  for (const m of ["normal", "busy", "focused-block", "slash-menu", "search", "approval"]) {
    const rows = renderHelpOverlay({ mode: m as HelpMode, width: 40, height: 8, color: false }, plain);
    assert.ok(rows.length >= 2);
    assert.ok(rows[rows.length - 1].includes("Esc"));
  }
});

test("normal render shows Enter and Ctrl+C", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 50, height: 14, color: false }, plain);
  const all = rows.join("\n");
  assert.ok(all.includes("Enter"));
  assert.ok(all.includes("Ctrl+C"));
});

test("approval render shows y/n keys", () => {
  const rows = renderHelpOverlay({ mode: "approval", width: 40, height: 10, color: false }, plain);
  const all = rows.join("\n");
  assert.ok(all.includes("y") || all.includes("approve"));
  assert.ok(all.includes("n") || all.includes("deny"));
});

// ── Borders ──────────────────────────────────────────────────────────────

test("no-color uses ASCII borders", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 40, height: 8, color: false }, plain);
  const all = rows.join("\n");
  assert.ok(!all.includes("\u256D")); // no ╭
  assert.ok(!all.includes("\u256E")); // no ╮
  assert.ok(!all.includes("\u2570")); // no ╰
  assert.ok(!all.includes("\u256F")); // no ╯
  assert.ok(all.includes("+"));
  assert.ok(all.includes("|"));
  assert.ok(all.includes("-"));
});

test("color uses Unicode box-drawing", () => {
  const rows = renderHelpOverlay({ mode: "normal", width: 40, height: 8, color: true }, color);
  const all = rows.join("\n");
  assert.ok(all.includes("\u256D"));
  assert.ok(all.includes("\u256E"));
  assert.ok(all.includes("\u2570"));
  assert.ok(all.includes("\u256F"));
});

// ── Helper ───────────────────────────────────────────────────────────────

function visWidth(s: string): number {
  return s.replace(SGR, "").length;
}
