/**
 * Phase 10A7 — slash command dropdown (pure catalog + menu).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLASH_CATALOG,
  filterSlashCommands,
  type SlashCommandInfo,
} from "../../src/cli/slashCatalog.js";
import {
  initSlashMenu,
  updateSlashMenu,
  moveSelection,
  completeSelected,
  closeSlashMenu,
  renderSlashMenu,
} from "../../src/ui/slashMenu.js";
import { createTheme } from "../../src/ui/theme.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";

const SGR = /\x1b\[[0-9;]*m/;

// ── catalog ────────────────────────────────────────────────────────────────

test("catalog only describes real commands and is well-formed", () => {
  const cats = new Set([
    "session", "context", "checks", "delegate", "web", "config", "debug",
  ]);
  assert.ok(SLASH_CATALOG.length > 0);
  for (const c of SLASH_CATALOG) {
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0);
    assert.ok(!c.name.startsWith("/"), `name should not include slash: ${c.name}`);
    assert.ok(cats.has(c.category), `bad category for ${c.name}: ${c.category}`);
    assert.equal(typeof c.description, "string");
  }
  // Spot-check a few real commands and their categories.
  const by = (n: string) => SLASH_CATALOG.find((c) => c.name === n);
  assert.equal(by("check")?.category, "checks");
  assert.equal(by("solve")?.category, "checks");
  assert.equal(by("delegate")?.category, "delegate");
  assert.equal(by("web")?.category, "web");
  assert.ok(by("exit")?.aliases?.includes("quit"));
});

test("filterSlashCommands: empty token returns all, stable order", () => {
  const all = filterSlashCommands(SLASH_CATALOG, "");
  assert.deepEqual(all.map((c) => c.name), SLASH_CATALOG.map((c) => c.name));
});

test("filterSlashCommands: case-insensitive prefix on name and aliases", () => {
  const ch = filterSlashCommands(SLASH_CATALOG, "CH").map((c) => c.name);
  assert.ok(ch.includes("check"));
  assert.ok(ch.includes("checks"));
  assert.ok(ch.includes("checkpoint"));
  // alias match: "qu" matches exit via alias "quit"
  const qu = filterSlashCommands(SLASH_CATALOG, "qu").map((c) => c.name);
  assert.ok(qu.includes("exit"));
});

// ── menu: open / filter ──────────────────────────────────────────────────────

test("`/` opens the menu with all commands", () => {
  const s = updateSlashMenu(initSlashMenu(), "/");
  assert.equal(s.open, true);
  assert.equal(s.query, "");
  assert.equal(s.matches.length, Math.min(8, SLASH_CATALOG.length));
  assert.equal(s.selected, 0);
});

test("`/de` filters to delegate-token commands", () => {
  const s = updateSlashMenu(initSlashMenu(), "/de");
  assert.equal(s.open, true);
  const names = s.matches.map((m) => m.name);
  assert.ok(names.includes("delegate"));
  for (const n of names) assert.ok(n.startsWith("de"), `unexpected match: ${n}`);
});

test("menu caps to top N (default 8) and respects custom maxVisible", () => {
  const def = updateSlashMenu(initSlashMenu(), "/");
  assert.ok(def.matches.length <= 8);
  const three = updateSlashMenu(initSlashMenu(), "/", 3);
  assert.equal(three.matches.length, 3);
});

// ── menu: selection (move + clamp) ───────────────────────────────────────────

test("Down/Up changes selection and clamps at both ends", () => {
  let s = updateSlashMenu(initSlashMenu(), "/c"); // several matches
  assert.ok(s.matches.length >= 2);
  s = moveSelection(s, 1);
  assert.equal(s.selected, 1);
  s = moveSelection(s, -1);
  assert.equal(s.selected, 0);
  // clamp low
  s = moveSelection(s, -5);
  assert.equal(s.selected, 0);
  // clamp high
  s = moveSelection(s, 999);
  assert.equal(s.selected, s.matches.length - 1);
});

// ── menu: completion ─────────────────────────────────────────────────────────

test("Tab/Enter completes the selected command text", () => {
  let s = updateSlashMenu(initSlashMenu(), "/ch");
  // first match
  const first = completeSelected(s);
  assert.equal(first, `/${s.matches[0]!.name} `);
  // move and complete a different one
  s = moveSelection(s, 1);
  assert.equal(completeSelected(s), `/${s.matches[1]!.name} `);
});

test("completeSelected returns null when menu is closed", () => {
  assert.equal(completeSelected(initSlashMenu()), null);
});

// ── menu: close ──────────────────────────────────────────────────────────────

test("Esc closes the menu", () => {
  const open = updateSlashMenu(initSlashMenu(), "/de");
  assert.equal(open.open, true);
  const closed = closeSlashMenu(open);
  assert.equal(closed.open, false);
  assert.equal(closed.matches.length, 0);
});

test("menu closes when input no longer starts with `/`", () => {
  const open = updateSlashMenu(initSlashMenu(), "/de");
  assert.equal(open.open, true);
  const reclosed = updateSlashMenu(open, "hello");
  assert.equal(reclosed.open, false);
  // also closes once the command token is complete (whitespace -> typing args)
  const args = updateSlashMenu(open, "/delegate plan");
  assert.equal(args.open, false);
});

// ── render: bounds + width-truncation + ASCII fallback ───────────────────────

test("render output is bounded and width-truncated", () => {
  const theme = createTheme(true);
  const s = updateSlashMenu(initSlashMenu(), "/");
  const width = 30;
  const out = renderSlashMenu(s, width, theme);
  assert.ok(out.length >= 3); // header + >=1 row + footer
  for (const line of out) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} :: ${JSON.stringify(line)}`,
    );
  }
});

test("closed menu renders nothing", () => {
  const out = renderSlashMenu(initSlashMenu(), 40, createTheme(true));
  assert.deepEqual(out, []);
});

test("createTheme(false) produces no SGR escape codes and ASCII box", () => {
  const theme = createTheme(false);
  const s = updateSlashMenu(initSlashMenu(), "/");
  const out = renderSlashMenu(s, 40, theme);
  const joined = out.join("\n");
  assert.equal(SGR.test(joined), false, "no SGR codes when color is off");
  // box-drawing chars must not appear in ASCII fallback
  assert.equal(/[╭╮╰╯─│]/.test(joined), false, "no box-drawing chars in ASCII fallback");
  assert.ok(out[0]!.startsWith("+"), "ASCII corner");
});

test("colored render uses box-drawing and SGR", () => {
  const theme = createTheme(true);
  const s = updateSlashMenu(initSlashMenu(), "/");
  const out = renderSlashMenu(s, 40, theme);
  const joined = out.join("\n");
  assert.ok(/[╭╮╰╯─│]/.test(joined), "box-drawing present when color on");
  assert.ok(SGR.test(joined), "SGR present when color on");
});

// keep type import referenced
const _typecheck: SlashCommandInfo | undefined = SLASH_CATALOG[0];
void _typecheck;
