/**
 * Phase 10A full TUI — block selection / expand-collapse (pure reducer).
 *
 * Collapsible blocks (tool / check / worker) render header-only by default; a
 * selection cursor (Tab steps through them) marks one as focused, and the focused
 * block — or one toggled with toggleExpand — shows its full body ("logs").
 * moveSelection skips non-collapsible blocks (user/assistant/notice).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTranscript,
  applyEvent,
  moveSelection,
  clearSelection,
  toggleExpand,
  type TranscriptState,
} from "../../src/ui/transcript.js";

function build(): TranscriptState {
  let s = createTranscript();
  s = applyEvent(s, { type: "assistant_delta", text: "hi" }); // not collapsible
  s = applyEvent(s, { type: "tool_result", name: "read_file", output: "A", isError: false });
  s = applyEvent(s, { type: "notice", message: "note" }); // not collapsible
  s = applyEvent(s, { type: "tool_result", name: "grep", output: "B", isError: false });
  return s;
}

function selectedKind(s: TranscriptState): string | undefined {
  return s.blocks.find((b) => b.id === s.selectedBlockId)?.title;
}

test("a fresh transcript has no selection", () => {
  assert.equal(createTranscript().selectedBlockId, null);
});

test("moveSelection forward selects the first collapsible block, skipping others", () => {
  const s = moveSelection(build(), 1);
  assert.equal(selectedKind(s), "read_file", "skipped the assistant block");
});

test("moveSelection steps to the next collapsible and clamps at the last", () => {
  let s = moveSelection(build(), 1); // read_file
  s = moveSelection(s, 1); // grep (skips the notice)
  assert.equal(selectedKind(s), "grep");
  s = moveSelection(s, 1); // clamp
  assert.equal(selectedKind(s), "grep", "clamped at last collapsible");
});

test("moveSelection backward from no selection picks the last collapsible", () => {
  const s = moveSelection(build(), -1);
  assert.equal(selectedKind(s), "grep");
});

test("toggleExpand flips the selected block's expanded flag", () => {
  let s = moveSelection(build(), 1); // read_file
  s = toggleExpand(s);
  assert.equal(s.blocks.find((b) => b.id === s.selectedBlockId)?.expanded, true);
  s = toggleExpand(s);
  assert.equal(s.blocks.find((b) => b.id === s.selectedBlockId)?.expanded, false);
});

test("clearSelection resets focus to null", () => {
  const s = clearSelection(moveSelection(build(), 1));
  assert.equal(s.selectedBlockId, null);
});
