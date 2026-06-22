/**
 * Phase 10A.7 Slice 3 — pure ChatUiState reducer.
 * Owns viewport (scroll/atBottom), the slash menu, focus region, and size.
 * No terminal I/O; the runTuiRepl shell folds keystrokes/mouse into these actions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initChatUi,
  reduceChatUi,
  type ChatUiState,
} from "../../src/ui/chatUiState.js";

const SIZE = { width: 80, height: 24 };
const ctx = (maxTop: number) => ({ maxTop });

test("initChatUi: at bottom, top 0, menu closed, focus composer", () => {
  const s = initChatUi(SIZE);
  assert.equal(s.viewportTop, 0);
  assert.equal(s.atBottom, true);
  assert.equal(s.slashMenu.open, false);
  assert.equal(s.focusedRegion, "composer");
  assert.deepEqual(s.size, SIZE);
});

test("scroll-up leaves bottom, decrements, clamps at 0", () => {
  let s = initChatUi(SIZE);
  s = { ...s, viewportTop: 5, atBottom: true };
  s = reduceChatUi(s, { type: "scroll-up" }, ctx(10));
  assert.equal(s.atBottom, false);
  assert.equal(s.viewportTop, 4);
  for (let i = 0; i < 10; i++) s = reduceChatUi(s, { type: "scroll-up" }, ctx(10));
  assert.equal(s.viewportTop, 0); // clamped, never negative
});

test("scroll-down clamps at maxTop and re-sticks to bottom there", () => {
  let s = initChatUi(SIZE);
  s = { ...s, viewportTop: 8, atBottom: false };
  s = reduceChatUi(s, { type: "scroll-down" }, ctx(10));
  assert.equal(s.viewportTop, 9);
  assert.equal(s.atBottom, false);
  s = reduceChatUi(s, { type: "scroll-down" }, ctx(10));
  assert.equal(s.viewportTop, 10);
  assert.equal(s.atBottom, true); // reached maxTop -> atBottom
  s = reduceChatUi(s, { type: "scroll-down" }, ctx(10));
  assert.equal(s.viewportTop, 10); // does not exceed maxTop
});

test("scroll-up/down honor an amount (mouse wheel / half-page)", () => {
  let s = initChatUi(SIZE);
  s = { ...s, viewportTop: 20, atBottom: false };
  s = reduceChatUi(s, { type: "scroll-up", amount: 3 }, ctx(30));
  assert.equal(s.viewportTop, 17);
  s = reduceChatUi(s, { type: "scroll-down", amount: 3 }, ctx(30));
  assert.equal(s.viewportTop, 20);
});

test("scroll-top and scroll-bottom", () => {
  let s = initChatUi(SIZE);
  s = reduceChatUi(s, { type: "scroll-top" }, ctx(10));
  assert.equal(s.viewportTop, 0);
  assert.equal(s.atBottom, false);
  s = reduceChatUi(s, { type: "scroll-bottom" }, ctx(10));
  assert.equal(s.viewportTop, 10);
  assert.equal(s.atBottom, true);
});

test("resize updates size, clamps viewportTop, and a stuck-bottom view follows", () => {
  let s = initChatUi(SIZE);
  s = { ...s, viewportTop: 50, atBottom: true };
  s = reduceChatUi(s, { type: "resize", width: 100, height: 40 }, ctx(12));
  assert.deepEqual(s.size, { width: 100, height: 40 });
  assert.equal(s.viewportTop, 12); // atBottom -> snapped to new maxTop
  // a detached view is merely clamped, not snapped
  let d = { ...initChatUi(SIZE), viewportTop: 50, atBottom: false };
  d = reduceChatUi(d, { type: "resize", width: 100, height: 40 }, ctx(12));
  assert.equal(d.viewportTop, 12);
  assert.equal(d.atBottom, false);
});

test("input-changed opens/filters/closes the slash menu and tracks focus", () => {
  let s = initChatUi(SIZE);
  s = reduceChatUi(s, { type: "input-changed", text: "/" }, ctx(0));
  assert.equal(s.slashMenu.open, true);
  assert.equal(s.focusedRegion, "slash-menu");
  const all = s.slashMenu.matches.length;
  s = reduceChatUi(s, { type: "input-changed", text: "/de" }, ctx(0));
  assert.ok(s.slashMenu.matches.length > 0 && s.slashMenu.matches.length <= all);
  assert.ok(s.slashMenu.matches.every((m) => m.name.startsWith("de") || (m.aliases ?? []).some((a) => a.startsWith("de"))));
  s = reduceChatUi(s, { type: "input-changed", text: "hello" }, ctx(0));
  assert.equal(s.slashMenu.open, false);
  assert.equal(s.focusedRegion, "composer");
});

test("menu-up/down move the selection only while the menu is open, clamped", () => {
  let s = reduceChatUi(initChatUi(SIZE), { type: "input-changed", text: "/" }, ctx(0));
  assert.equal(s.slashMenu.selected, 0);
  s = reduceChatUi(s, { type: "menu-down" }, ctx(0));
  assert.equal(s.slashMenu.selected, 1);
  s = reduceChatUi(s, { type: "menu-up" }, ctx(0));
  assert.equal(s.slashMenu.selected, 0);
  s = reduceChatUi(s, { type: "menu-up" }, ctx(0)); // clamp at 0
  assert.equal(s.slashMenu.selected, 0);
  // closed menu ignores nav
  const closed = reduceChatUi(initChatUi(SIZE), { type: "menu-down" }, ctx(0));
  assert.equal(closed.slashMenu.open, false);
  assert.equal(closed.slashMenu.selected, 0);
});

test("menu-close closes without touching the composer focus path", () => {
  let s = reduceChatUi(initChatUi(SIZE), { type: "input-changed", text: "/de" }, ctx(0));
  s = reduceChatUi(s, { type: "menu-close" }, ctx(0));
  assert.equal(s.slashMenu.open, false);
});

test("submit closes the menu, returns to bottom and composer focus", () => {
  let s = reduceChatUi(initChatUi(SIZE), { type: "input-changed", text: "/check" }, ctx(10));
  s = { ...s, viewportTop: 3, atBottom: false };
  s = reduceChatUi(s, { type: "submit" }, ctx(10));
  assert.equal(s.slashMenu.open, false);
  assert.equal(s.atBottom, true);
  assert.equal(s.viewportTop, 10);
  assert.equal(s.focusedRegion, "composer");
});

test("reducer is pure: it never mutates the input state", () => {
  const s = initChatUi(SIZE);
  const frozen = Object.freeze({ ...s });
  const next = reduceChatUi(frozen as ChatUiState, { type: "scroll-down" }, ctx(5));
  assert.notEqual(next, frozen);
  assert.equal(frozen.viewportTop, 0); // unchanged
});
