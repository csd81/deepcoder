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
