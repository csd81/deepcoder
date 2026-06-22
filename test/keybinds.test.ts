import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKeybinds, actionForKey } from "../src/ui/keybinds.js";

// Red-seed anchor (do NOT weaken). Pure keymap parse/merge — no I/O.

test("resolveKeybinds(undefined) returns the defaults", () => {
  const kb = resolveKeybinds(undefined);
  assert.equal(kb["enter"], "submit");
  assert.equal(kb["ctrl+p"], "scroll-up");
});

test("resolveKeybinds merges user overrides over defaults", () => {
  const kb = resolveKeybinds({ "ctrl+p": "cancel" });
  assert.equal(kb["ctrl+p"], "cancel", "override wins");
  assert.equal(kb["enter"], "submit", "untouched default kept");
});

test("actionForKey maps plain and chorded keys", () => {
  const kb = resolveKeybinds(undefined);
  assert.equal(actionForKey(kb, { key: "enter" }), "submit");
  assert.equal(actionForKey(kb, { key: "p", ctrl: true }), "scroll-up");
});

test("actionForKey returns null for an unbound chord", () => {
  const kb = resolveKeybinds(undefined);
  assert.equal(actionForKey(kb, { key: "z", ctrl: true, alt: true }), null);
});
