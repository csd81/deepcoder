/**
 * Phase 10A full TUI — input editor (pure, no I/O).
 *
 * A small text buffer with a cursor, multiline support (newline inserts "\n"),
 * and submitted-prompt history (Up recalls older, Down newer, with the in-progress
 * draft restored at the end). All transitions are pure: reduceEditor(state, action)
 * -> { state, submitted? }.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEditor, reduceEditor } from "../../src/ui/inputEditor.js";

function typeText(s: string, text: string) {
  let st = s;
  for (const ch of text) st = reduceEditor(st, { type: "insert", ch }).state;
  return st;
}

test("inserting characters builds text and advances the cursor", () => {
  const st = typeText(createEditor(), "hi");
  assert.equal(st.text, "hi");
  assert.equal(st.cursor, 2);
});

test("backspace deletes the character before the cursor", () => {
  const st = reduceEditor(typeText(createEditor(), "hi"), { type: "backspace" }).state;
  assert.equal(st.text, "h");
  assert.equal(st.cursor, 1);
});

test("newline inserts a line break (multiline)", () => {
  let st = typeText(createEditor(), "a");
  st = reduceEditor(st, { type: "newline" }).state;
  st = typeText(st, "b");
  assert.equal(st.text, "a\nb");
});

test("submit returns the text, records history, and clears the buffer", () => {
  const st0 = typeText(createEditor(), "first");
  const r = reduceEditor(st0, { type: "submit" });
  assert.equal(r.submitted, "first");
  assert.equal(r.state.text, "", "buffer cleared");
  assert.equal(r.state.cursor, 0);
  assert.deepEqual(r.state.history, ["first"]);
});

test("history Up/Down recalls prior submissions and restores the draft", () => {
  let st = reduceEditor(typeText(createEditor(), "one"), { type: "submit" }).state;
  st = reduceEditor(typeText(st, "two"), { type: "submit" }).state;
  st = typeText(st, "draft"); // in-progress, not yet submitted

  st = reduceEditor(st, { type: "history-prev" }).state; // -> "two"
  assert.equal(st.text, "two");
  st = reduceEditor(st, { type: "history-prev" }).state; // -> "one"
  assert.equal(st.text, "one");
  st = reduceEditor(st, { type: "history-prev" }).state; // clamped at oldest
  assert.equal(st.text, "one");

  st = reduceEditor(st, { type: "history-next" }).state; // -> "two"
  assert.equal(st.text, "two");
  st = reduceEditor(st, { type: "history-next" }).state; // -> restored draft
  assert.equal(st.text, "draft", "draft restored at the end of history");
});

test("history navigation with empty history is a no-op", () => {
  const st = reduceEditor(createEditor(), { type: "history-prev" }).state;
  assert.equal(st.text, "");
});

test("submitting whitespace-only does not pollute history", () => {
  const r = reduceEditor(typeText(createEditor(), "   "), { type: "submit" });
  assert.equal(r.submitted, "   ", "still returns what was typed");
  assert.deepEqual(r.state.history, [], "but blank entries are not recorded");
});

// ── cursor movement (left/right/home/end) + mid-string editing ──
test("left/right move the cursor and clamp at the ends", () => {
  let s = createEditor();
  for (const ch of "abc") s = reduceEditor(s, { type: "insert", ch }).state;
  assert.equal(s.cursor, 3);
  s = reduceEditor(s, { type: "left" }).state;
  assert.equal(s.cursor, 2);
  s = reduceEditor(s, { type: "left" }).state;
  s = reduceEditor(s, { type: "left" }).state;
  s = reduceEditor(s, { type: "left" }).state; // clamp at 0
  assert.equal(s.cursor, 0);
  s = reduceEditor(s, { type: "right" }).state;
  assert.equal(s.cursor, 1);
  for (let i = 0; i < 9; i++) s = reduceEditor(s, { type: "right" }).state; // clamp at end
  assert.equal(s.cursor, 3);
});

test("home/end jump to the ends; insert happens at the cursor mid-string", () => {
  let s = createEditor();
  for (const ch of "ac") s = reduceEditor(s, { type: "insert", ch }).state;
  s = reduceEditor(s, { type: "home" }).state;
  assert.equal(s.cursor, 0);
  s = reduceEditor(s, { type: "right" }).state; // between a and c
  s = reduceEditor(s, { type: "insert", ch: "b" }).state;
  assert.equal(s.text, "abc", "inserted at the cursor, not appended");
  s = reduceEditor(s, { type: "end" }).state;
  assert.equal(s.cursor, 3);
  s = reduceEditor(s, { type: "backspace" }).state; // deletes at cursor (end)
  assert.equal(s.text, "ab");
});

test("backspace deletes the char before the cursor mid-string", () => {
  let s = createEditor();
  for (const ch of "abc") s = reduceEditor(s, { type: "insert", ch }).state;
  s = reduceEditor(s, { type: "left" }).state; // cursor between b and c
  s = reduceEditor(s, { type: "backspace" }).state; // delete b
  assert.equal(s.text, "ac");
  assert.equal(s.cursor, 1);
});
