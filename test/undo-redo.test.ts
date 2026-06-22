import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initState,
  pushTurn,
  undo,
  redo,
  onNewMutation,
  type UndoEntry,
} from "../src/cli/undoRedo.js";

// Red-seed anchor (do NOT weaken). Pure undo/redo stack — no I/O.

const entry = (label: string): UndoEntry => ({
  label,
  files: [{ path: `${label}.ts`, existed: true, restoreSha: "sha-" + label }],
});

test("initState defaults", () => {
  assert.deepEqual(initState(), { undoStack: [], redoStack: [], maxDepth: 20 });
});

test("pushTurn then undo then redo round-trips a single entry", () => {
  let s = pushTurn(initState(), entry("a"));
  assert.equal(s.undoStack.length, 1);
  assert.equal(s.redoStack.length, 0);

  const u = undo(s);
  assert.equal(u.entry?.label, "a");
  assert.equal(u.state.undoStack.length, 0);
  assert.equal(u.state.redoStack.length, 1);

  const r = redo(u.state);
  assert.equal(r.entry?.label, "a");
  assert.equal(r.state.redoStack.length, 0);
  assert.equal(r.state.undoStack.length, 1);
});

test("undo/redo on empty stacks are no-ops returning null", () => {
  const u = undo(initState());
  assert.equal(u.entry, null);
  const r = redo(initState());
  assert.equal(r.entry, null);
});

test("onNewMutation clears the redo stack, keeps undo stack", () => {
  let s = pushTurn(initState(), entry("a"));
  s = undo(s).state; // redoStack now has 'a'
  assert.equal(s.redoStack.length, 1);
  const cleared = onNewMutation(s);
  assert.equal(cleared.redoStack.length, 0);
});

test("pushTurn evicts the oldest entry at maxDepth (FIFO)", () => {
  let s = initState(2);
  s = pushTurn(s, entry("a"));
  s = pushTurn(s, entry("b"));
  s = pushTurn(s, entry("c"));
  assert.equal(s.undoStack.length, 2);
  assert.equal(s.undoStack[0]!.label, "b", "oldest ('a') evicted");
  assert.equal(s.undoStack[1]!.label, "c");
});
