/**
 * Phase 10A (slice 1) — pure UI core. SEED (red-first) anchor: pins the
 * transcript reducer contract (assistant deltas coalesce into one block) so a
 * delegated worker MUST implement the pure event/transcript model (no
 * green-check no-op), then EXTENDS this file with the remaining pure cases from
 * plans/phase10a-scrollable-terminal-ui-plan.md (Testing → Pure tests).
 *
 * All 8 pure tests:
 *   1. assistant deltas coalesce into one block (seed)
 *   2. tool results create separate blocks
 *   3. a large block collapses (exceeds collapseToolOutputAfterBytes)
 *   4. the transcript total-byte cap evicts old blocks
 *   5. scroll state follows the bottom by default
 *   6. scrolling up disables auto-follow
 *   7. a "new output below" indicator appears when not at bottom
 *   8. status patches merge
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTranscript,
  applyEvent,
  scrollUp,
  scrollToBottom,
  _resetIds,
} from "../../src/ui/transcript.js";
import type { UiConfig } from "../../src/ui/events.js";
import { DEFAULT_UI_CONFIG } from "../../src/ui/events.js";

// ── Test 1: assistant deltas coalesce into one block (seed) ─────────────────

test("[transcript-assistant-delta] assistant deltas coalesce into one block", () => {
  _resetIds();
  let t = createTranscript();
  t = applyEvent(t, { type: "assistant_delta", text: "Hello " });
  t = applyEvent(t, { type: "assistant_delta", text: "world" });
  const assistant = t.blocks.filter((b) => b.kind === "assistant");
  assert.equal(assistant.length, 1, "streamed deltas append into a single assistant block");
  assert.equal(assistant[0].body, "Hello world");
});

// ── Test 2: tool results create separate blocks ─────────────────────────────

test("[transcript-tool-blocks] tool results create separate blocks", () => {
  _resetIds();
  let t = createTranscript();

  t = applyEvent(t, { type: "tool_start", name: "read_file", description: "Read src/foo.ts" });
  t = applyEvent(t, {
    type: "tool_result",
    name: "read_file",
    output: "file contents here",
    isError: false,
  });

  t = applyEvent(t, { type: "tool_start", name: "grep", description: "Search for pattern" });
  t = applyEvent(t, {
    type: "tool_result",
    name: "grep",
    output: "line1\nline2",
    isError: false,
  });

  const toolBlocks = t.blocks.filter((b) => b.kind === "tool");
  // tool_start and tool_result each create their own block → 4 blocks for 2 tools
  assert.equal(toolBlocks.length, 4, "tool_start + tool_result each create a block");
  // tool_start blocks have empty body; tool_result blocks carry the output
  assert.equal(toolBlocks[0].title, "read_file");
  assert.equal(toolBlocks[0].body, "");
  assert.equal(toolBlocks[1].title, "read_file");
  assert.equal(toolBlocks[1].body, "file contents here");
  assert.equal(toolBlocks[2].title, "grep");
  assert.equal(toolBlocks[2].body, "");
  assert.equal(toolBlocks[3].title, "grep");
  assert.equal(toolBlocks[3].body, "line1\nline2");
});

// ── Test 3: a large block collapses ─────────────────────────────────────────

test("[transcript-large-collapse] a large block collapses when exceeding collapseToolOutputAfterBytes", () => {
  _resetIds();
  const smallConfig: UiConfig = {
    ...DEFAULT_UI_CONFIG,
    collapseToolOutputAfterBytes: 100,
    transcriptMaxBytes: 1_000_000,
  };

  let t = createTranscript(smallConfig);

  // Build output that exceeds the 100-byte threshold (and is large enough that
  // the collapsed head+tail is meaningfully smaller than the original)
  const line = "B".repeat(200) + "\n";
  const largeOutput = line.repeat(30); // ~6030 bytes — well over 100

  t = applyEvent(
    t,
    { type: "tool_result", name: "read_file", output: largeOutput, isError: false },
    smallConfig,
  );

  const toolBlocks = t.blocks.filter((b) => b.kind === "tool");
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].collapsed, true, "large block should be marked collapsed");
  assert.ok(
    toolBlocks[0].body.length < largeOutput.length,
    "collapsed body should be shorter than original",
  );
  assert.ok(toolBlocks[0].body.includes("[collapsed,"), "collapsed body should contain summary marker");
  assert.ok(toolBlocks[0].body.startsWith("B".repeat(200) + "\n"), "collapsed body should retain head");
  assert.ok(toolBlocks[0].body.endsWith("B".repeat(200) + "\n"), "collapsed body should retain tail");
});

// ── Test 4: transcript total-byte cap evicts old blocks ─────────────────────

test("[transcript-byte-cap] transcript total-byte cap evicts old blocks", () => {
  _resetIds();
  const tinyConfig: UiConfig = {
    ...DEFAULT_UI_CONFIG,
    collapseToolOutputAfterBytes: 1_000_000, // disable collapse for this test
    transcriptMaxBytes: 200, // very small cap
  };

  let t = createTranscript(tinyConfig);

  // Add a block with 150 bytes
  t = applyEvent(
    t,
    { type: "tool_result", name: "first", output: "X".repeat(150), isError: false },
    tinyConfig,
  );
  assert.equal(t.blocks.length, 1, "first block fits");

  // Add another block with 100 bytes — total would be 250 > 200, so oldest evicted
  t = applyEvent(
    t,
    { type: "tool_result", name: "second", output: "Y".repeat(100), isError: false },
    tinyConfig,
  );

  assert.equal(t.blocks.length, 1, "oldest block evicted to stay under byte cap");
  assert.equal(t.blocks[0].title, "second", "only the second block remains");
  assert.ok(t.totalBytes <= tinyConfig.transcriptMaxBytes, "totalBytes respects the cap");
});

// ── Test 5: scroll state follows the bottom by default ──────────────────────

test("[transcript-scroll-follow] scroll state follows the bottom by default", () => {
  _resetIds();
  let t = createTranscript();
  assert.equal(t.atBottom, true, "new transcript starts at bottom");

  // New output while at bottom keeps atBottom=true
  t = applyEvent(t, { type: "assistant_delta", text: "Hello" });
  assert.equal(t.atBottom, true, "still at bottom after new output");
  assert.equal(t.hasNewOutputBelow, false, "no new-output indicator when at bottom");
});

// ── Test 6: scrolling up disables auto-follow ───────────────────────────────

test("[transcript-scroll-up] scrolling up disables auto-follow", () => {
  _resetIds();
  let t = createTranscript();

  // Scroll up
  t = scrollUp(t);
  assert.equal(t.atBottom, false, "scrollUp sets atBottom=false");
  assert.equal(t.hasNewOutputBelow, false, "no new-output indicator immediately after scroll");

  // New output while not at bottom should NOT yank viewport
  t = applyEvent(t, { type: "assistant_delta", text: "More output" });
  assert.equal(t.atBottom, false, "still not at bottom after new output while scrolled up");

  // Return to bottom
  t = scrollToBottom(t);
  assert.equal(t.atBottom, true, "scrollToBottom restores atBottom=true");
  assert.equal(t.hasNewOutputBelow, false, "returning to bottom clears indicator");
});

// ── Test 7: "new output below" indicator appears when not at bottom ─────────

test("[transcript-new-output-below] new output below indicator appears when not at bottom", () => {
  _resetIds();
  let t = createTranscript();

  // Start at bottom, then scroll up
  t = scrollUp(t);
  assert.equal(t.atBottom, false);
  assert.equal(t.hasNewOutputBelow, false);

  // New output while scrolled up sets hasNewOutputBelow=true
  t = applyEvent(t, { type: "assistant_delta", text: "Fresh content" });
  assert.equal(t.hasNewOutputBelow, true, "new output while scrolled up sets indicator");

  // Return to bottom clears it
  t = scrollToBottom(t);
  assert.equal(t.atBottom, true);
  assert.equal(t.hasNewOutputBelow, false, "returning to bottom clears new-output indicator");
});

// ── Test 8: status patches merge ────────────────────────────────────────────

test("[transcript-status-merge] status patches merge shallowly", () => {
  _resetIds();
  let t = createTranscript();

  t = applyEvent(t, { type: "status", patch: { mode: "auto", model: "deepseek-v3" } });
  assert.equal(t.status.mode, "auto");
  assert.equal(t.status.model, "deepseek-v3");

  // Second patch merges (does not replace)
  t = applyEvent(t, { type: "status", patch: { provider: "deepseek" } });
  assert.equal(t.status.mode, "auto", "mode preserved from first patch");
  assert.equal(t.status.model, "deepseek-v3", "model preserved from first patch");
  assert.equal(t.status.provider, "deepseek", "provider added from second patch");

  // Overwrite an existing field
  t = applyEvent(t, { type: "status", patch: { mode: "ask" } });
  assert.equal(t.status.mode, "ask", "mode overwritten by later patch");
  assert.equal(t.status.model, "deepseek-v3", "other fields unchanged");
});

test("[transcript-done-newblock] a new assistant message after assistant_done starts a fresh block", () => {
  _resetIds();
  let s = createTranscript();
  s = applyEvent(s, { type: "assistant_delta", text: "first" });
  s = applyEvent(s, { type: "assistant_done" });
  const a = s.blocks.filter((b) => b.kind === "assistant");
  assert.equal(a.length, 1);
  assert.equal(a[0].finishedAt, "", "block is marked finished (empty-string sentinel)");

  // A new delta must NOT reopen the finished block (the "" sentinel is falsy).
  s = applyEvent(s, { type: "assistant_delta", text: "second" });
  const a2 = s.blocks.filter((b) => b.kind === "assistant");
  assert.equal(a2.length, 2, "a new assistant block is created, not coalesced into the finished one");
  assert.equal(a2[0].body, "first");
  assert.equal(a2[1].body, "second");
  assert.equal(a2[1].finishedAt, undefined, "the new block is open");
});
