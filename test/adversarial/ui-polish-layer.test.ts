/**
 * Phase 10A.19 — UI Polish Layer (pure module) adversarial tests.
 *
 * Covers the plan's test bullets for styleTokens.ts, emptyState.ts, and
 * transcriptPresenter.ts:
 *
 *  1. Empty transcript renders useful bounded empty state.
 *  2. User and assistant blocks render with distinct role headers.
 *  3. System/internal blocks are dim/secondary.
 *  4. Tool blocks render as compact cards when collapsed.
 *  5. Expanded tool/check cards show bounded previews.
 *  6. Check pass/fail cards use distinct semantic markers.
 *  7. Selected card is visibly marked but width-bounded.
 *  8. Very narrow terminal still produces non-overlapping lines.
 *  9. `NO_COLOR` output has no ANSI codes but remains readable.
 * 10. Long model/check/worker labels truncate safely.
 * 11. No secret-looking strings appear unredacted in previews.
 * 12. Snapshot-style output remains deterministic.
 * 13. Empty state is bounded by height.
 * 14. StyleTokens chrome symbols are present in output.
 * 15. Role styling functions apply correct theme styles.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTheme } from "../../src/ui/theme.js";
import { createStyleTokens } from "../../src/ui/styleTokens.js";
import { renderEmptyState } from "../../src/ui/emptyState.js";
import {
  presentTranscript,
  type PresentTranscriptInput,
} from "../../src/ui/transcriptPresenter.js";
import type { TranscriptBlock } from "../../src/ui/transcript.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const colorTheme = createTheme(true);
const plainTheme = createTheme(false);
const colorTokens = createStyleTokens(colorTheme);
const plainTokens = createStyleTokens(plainTheme);
const WIDE = 200;

/** Build a TranscriptBlock shortcut. */
function block(overrides: Partial<TranscriptBlock> & { kind: TranscriptBlock["kind"] }): TranscriptBlock {
  return {
    id: overrides.id ?? "b1",
    body: "",
    startedAt: "",
    ...overrides,
  };
}

/** Wrap presentTranscript with sensible defaults. */
function present(input: Partial<PresentTranscriptInput> & { blocks: readonly TranscriptBlock[] }): PresentedBlock[] {
  return presentTranscript({
    blocks: input.blocks,
    width: input.width ?? WIDE,
    selectedId: input.selectedId,
    tokens: input.tokens ?? colorTokens,
    emptyState: input.emptyState,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. StyleTokens
// ═════════════════════════════════════════════════════════════════════════════

test("[styleTokens-structure] createStyleTokens returns all expected sections", () => {
  const t = createStyleTokens(colorTheme);
  // role section
  assert.equal(typeof t.role.user, "function");
  assert.equal(typeof t.role.assistant, "function");
  assert.equal(typeof t.role.system, "function");
  assert.equal(typeof t.role.tool, "function");
  assert.equal(typeof t.role.check, "function");
  assert.equal(typeof t.role.worker, "function");

  // state section
  assert.equal(typeof t.state.success, "function");
  assert.equal(typeof t.state.error, "function");
  assert.equal(typeof t.state.warning, "function");
  assert.equal(typeof t.state.running, "function");
  assert.equal(typeof t.state.muted, "function");
  assert.equal(typeof t.state.selected, "function");

  // chrome section
  assert.equal(typeof t.chrome.separator, "string");
  assert.equal(typeof t.chrome.bulletCollapsed, "string");
  assert.equal(typeof t.chrome.bulletExpanded, "string");
  assert.equal(typeof t.chrome.checkPass, "string");
  assert.equal(typeof t.chrome.checkFail, "string");
});

test("[styleTokens-chrome-symbols] chrome symbols are the expected Unicode characters", () => {
  const t = createStyleTokens(colorTheme);
  assert.equal(t.chrome.separator, "─");
  assert.equal(t.chrome.bulletCollapsed, "▸");
  assert.equal(t.chrome.bulletExpanded, "▾");
  assert.equal(t.chrome.checkPass, "✓");
  assert.equal(t.chrome.checkFail, "✗");
});

test("[styleTokens-role-styles] role functions apply correct theme styles (color enabled)", () => {
  const t = createStyleTokens(colorTheme);
  // user/assistant → bold (via theme.title: SGR 1)
  assert.ok(t.role.user("You").startsWith("\x1b[1m"), "user header is bold");
  assert.ok(t.role.assistant("Deepcoder").startsWith("\x1b[1m"), "assistant header is bold");

  // system/tool/check/worker → dim, now a readable grey truecolor (not faint SGR 2)
  assert.ok(t.role.system("System").startsWith("\x1b[38;2;"), "system header is grey (not faint)");
  assert.ok(t.role.tool("tool x").startsWith("\x1b[38;2;"), "tool header is grey (not faint)");
  assert.ok(t.role.check("check y").startsWith("\x1b[38;2;"), "check header is grey (not faint)");
  assert.ok(t.role.worker("worker z").startsWith("\x1b[38;2;"), "worker header is grey (not faint)");

  // Content preserved inside the escape codes
  assert.ok(t.role.user("You").includes("You"), "content preserved in role styling");
});

test("[styleTokens-state-styles] state functions apply correct theme styles (color enabled)", () => {
  const t = createStyleTokens(colorTheme);

  // success/error/warning → bold + darker truecolor (legible on a pale background)
  assert.ok(t.state.success("ok").includes("\x1b[1;38;2;"), "success is bold truecolor green");
  assert.ok(t.state.error("fail").includes("\x1b[1;38;2;"), "error is bold truecolor red");
  assert.ok(t.state.warning("warn").includes("\x1b[1;38;2;"), "warning is bold truecolor amber");
  // running → SGR 1 (bold, via theme.title)
  assert.ok(t.state.running("run").includes("\x1b[1m"), "running uses bold");
  // muted → dim, now a readable grey truecolor (not faint SGR 2)
  assert.ok(t.state.muted("mute").includes("\x1b[38;2;"), "muted is grey (not faint)");
  // selected → SGR 7 (invert)
  assert.ok(t.state.selected("sel").includes("\x1b[7m"), "selected uses invert");
});

test("[styleTokens-plain] plain/no-color tokens produce no ANSI escape codes", () => {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[/;
  const t = createStyleTokens(plainTheme);

  for (const fn of [
    t.role.user, t.role.assistant, t.role.system,
    t.role.tool, t.role.check, t.role.worker,
    t.state.success, t.state.error, t.state.warning,
    t.state.running, t.state.muted, t.state.selected,
  ]) {
    const out = fn("test");
    assert.doesNotMatch(out, ansi, `identity style for plain tokens: ${out}`);
    assert.equal(out, "test", "identity preserves content");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. Empty State
// ═════════════════════════════════════════════════════════════════════════════

test("[emptyState-renders] empty state renders with useful content", () => {
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: plainTokens });

  assert.ok(lines.length > 0, "empty state has lines");
  assert.ok(lines.some((l) => l.includes("Deepcoder")), "contains Deepcoder header");
  assert.ok(
    lines.some((l) => l.includes("/doctor")),
    "contains /doctor suggestion",
  );
  assert.ok(
    lines.some((l) => l.includes("commands")),
    "contains instructional text",
  );
});

test("[emptyState-bounded-height] empty state is bounded by height", () => {
  const linesShort = renderEmptyState({ width: WIDE, height: 3, tokens: plainTokens });
  assert.ok(linesShort.length <= 3, `height=3 yields ≤3 lines (got ${linesShort.length})`);

  const linesTall = renderEmptyState({ width: WIDE, height: 30, tokens: plainTokens });
  assert.ok(linesTall.length <= 30, `height=30 yields ≤30 lines`);
  // Taller height should include more commands
  assert.ok(linesTall.length > linesShort.length, "taller height shows more content");
});

test("[emptyState-min-height] empty state returns empty array when height too small", () => {
  const lines = renderEmptyState({ width: WIDE, height: 1, tokens: plainTokens });
  assert.equal(lines.length, 0, "height=1 returns no lines");
});

test("[emptyState-width-bounded] each line is truncated to width", () => {
  for (const w of [80, 40, 20, 10]) {
    const lines = renderEmptyState({ width: w, height: 10, tokens: plainTokens });
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= w, `width=${w} visibleWidth=${visibleWidth(line)}: "${line}"`);
    }
  }
});

test("[emptyState-no-ansi] plain tokens produce no escape codes in empty state", () => {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[/;
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: plainTokens });
  for (const line of lines) {
    assert.doesNotMatch(line, ansi, `no ANSI in plain empty state: "${line}"`);
  }
});

test("[emptyState-color] color tokens produce ANSI codes in empty state", () => {
  const lines = renderEmptyState({ width: WIDE, height: 20, tokens: colorTokens });
  const all = lines.join("");
  // At least the header (Deepcoder → bold) should have ANSI
  assert.ok(all.includes("\x1b["), "color empty state includes ANSI codes");
});

test("[emptyState-deterministic] same inputs produce identical output", () => {
  const a = renderEmptyState({ width: 80, height: 15, tokens: plainTokens });
  const b = renderEmptyState({ width: 80, height: 15, tokens: plainTokens });
  assert.deepEqual(a, b);
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. Transcript Presenter — User / Assistant Role Headers
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-user-header] user block renders with 'You' header", () => {
  const presented = present({
    blocks: [block({ kind: "user", body: "implement /doctor", id: "b1" })],
  });
  assert.equal(presented.length, 1);
  assert.ok(presented[0].lines.some((l) => l.includes("You")), "contains 'You' header");
  assert.ok(presented[0].lines.some((l) => l.includes("implement /doctor")), "contains body");
  assert.equal(presented[0].focusable, false, "user blocks are not focusable");
});

test("[presenter-assistant-header] assistant block renders with 'Deepcoder' header", () => {
  const presented = present({
    blocks: [block({ kind: "assistant", body: "I'll inspect the code first.", id: "b1" })],
  });
  assert.ok(presented[0].lines.some((l) => l.includes("Deepcoder")), "contains 'Deepcoder' header");
  assert.ok(presented[0].lines.some((l) => l.includes("I'll inspect")), "contains body");
  assert.equal(presented[0].focusable, false, "assistant blocks are not focusable");
});

test("[presenter-user-vs-assistant] user and assistant blocks have distinct headers", () => {
  const presented = present({
    blocks: [
      block({ kind: "user", body: "hello", id: "b1" }),
      block({ kind: "assistant", body: "hi there", id: "b2" }),
    ],
  });
  const allLines = presented.flatMap((p) => p.lines).join("\n");
  assert.ok(allLines.includes("You"), "first block has 'You' header");
  assert.ok(allLines.includes("Deepcoder"), "second block has 'Deepcoder' header");
});

test("[presenter-major-block-spacer] consecutive major blocks get a blank-line spacer", () => {
  const presented = present({
    blocks: [
      block({ kind: "user", body: "first", id: "b1" }),
      block({ kind: "assistant", body: "reply", id: "b2" }),
    ],
  });
  // b1 + spacer + b2 = 3 PresentedBlocks
  assert.equal(presented.length, 3, "user + spacer + assistant = 3 entries");
  assert.equal(presented[0].id, "b1");
  assert.equal(presented[1].id, "b2-spacer", "spacer between major blocks");
  assert.equal(presented[2].id, "b2");
  assert.deepEqual(presented[1].lines, [""], "spacer is a blank line");
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. System / Secondary blocks
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-system-header] system block renders dim header", () => {
  const presented = present({
    blocks: [block({ kind: "system", body: "internal metadata", id: "b1" })],
    tokens: plainTokens,
  });
  assert.ok(presented[0].lines.some((l) => l.includes("System")), "contains 'System' header");
  assert.ok(presented[0].lines.some((l) => l.includes("internal")), "contains body");
  assert.equal(presented[0].focusable, false, "system blocks are not focusable");
});

test("[presenter-notice-header] notice block renders dim 'Notice' header", () => {
  const presented = present({
    blocks: [block({ kind: "notice", body: "something happened", id: "b1" })],
    tokens: plainTokens,
  });
  assert.ok(presented[0].lines.some((l) => l.includes("Notice")), "notice has 'Notice' header");
});

test("[presenter-approval-header] approval block renders dim 'Approval' header", () => {
  const presented = present({
    blocks: [block({ kind: "approval", body: "approved", id: "b1" })],
    tokens: plainTokens,
  });
  assert.ok(presented[0].lines.some((l) => l.includes("Approval")), "approval has 'Approval' header");
});

// ═════════════════════════════════════════════════════════════════════════════
//  5. Compact card rendering
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-tool-card-collapsed] collapsed tool block renders as compact card", () => {
  const presented = present({
    blocks: [block({ kind: "tool", title: "read_file", body: "file contents\nline2\nline3", id: "b1" })],
    tokens: plainTokens,
  });
  assert.equal(presented.length, 1, "one presented block");
  const cardLine = presented[0].lines[0];
  assert.ok(cardLine.includes("▸"), "collapsed card has bullet");
  assert.ok(cardLine.includes("tool read_file"), "card has tool kind + title");
  assert.ok(cardLine.includes("3 lines"), "card has summary");
  assert.equal(presented[0].focusable, true, "tool blocks are focusable");
});

test("[presenter-check-card-pass] passed check card shows checkPass marker", () => {
  const presented = present({
    blocks: [block({ kind: "check", title: "phase", body: "42 passed\n0 failed", id: "b1", finishedAt: "" })],
    tokens: plainTokens,
  });
  const cardLine = presented[0].lines[0];
  assert.ok(cardLine.includes("✓"), "passed check shows check mark");
  assert.ok(cardLine.includes("42 passed"), "summary includes passed count");
});

test("[presenter-check-card-fail] failed check card shows checkFail marker", () => {
  const presented = present({
    blocks: [block({ kind: "check", title: "unit", body: "FAILED test/foo.test.ts\n3 failed", id: "b1", finishedAt: "", isError: true })],
    tokens: plainTokens,
  });
  const cardLine = presented[0].lines[0];
  assert.ok(cardLine.includes("✗"), "failed check shows X mark");
  assert.ok(cardLine.includes("3 failed"), "summary includes failed count");
});

test("[presenter-worker-card] worker block renders as compact card with bullet", () => {
  const presented = present({
    blocks: [block({ kind: "worker", title: "delegate", body: "solved in 2 attempts", id: "b1" })],
    tokens: plainTokens,
  });
  const cardLine = presented[0].lines[0];
  assert.ok(cardLine.includes("▸"), "worker card has collapsed bullet");
  assert.ok(cardLine.includes("worker delegate"), "card has worker kind + title");
});

// ═════════════════════════════════════════════════════════════════════════════
//  6. Expanded cards with bounded previews
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-tool-expanded] expanded tool card shows bounded preview lines", () => {
  const bodyLines: string[] = [];
  for (let i = 1; i <= 10; i++) bodyLines.push(`line ${i}`);
  const presented = present({
    blocks: [block({ kind: "tool", title: "read_file", body: bodyLines.join("\n"), id: "b1", expanded: true, finishedAt: "" })],
    tokens: plainTokens,
  });
  // Card header line + up to 3 preview lines (default from buildBlockPreview)
  assert.ok(presented[0].lines.length > 1, "expanded card has preview lines beyond header");
  assert.ok(presented[0].lines.some((l) => l.includes("line 1")), "preview includes first meaningful line");
  // Should not overflow to line 10 (capped by buildBlockPreview)
  assert.ok(!presented[0].lines.some((l) => l.includes("line 10")), "preview is bounded");
});

test("[presenter-check-expanded] expanded check card shows bounded preview", () => {
  const presented = present({
    blocks: [block({ kind: "check", title: "unit", body: "FAILED test/foo.test.ts:42\n  Expected 1, got 0\nmore details", id: "b1", expanded: true, finishedAt: "", isError: true })],
    tokens: plainTokens,
  });
  const cardLine = presented[0].lines[0];
  assert.ok(cardLine.includes("✗"), "expanded error check shows X");
  // Should have preview lines (the failure line)
  const previewLines = presented[0].lines.slice(1);
  assert.ok(previewLines.length > 0, "expanded check has preview lines");
});

// ═════════════════════════════════════════════════════════════════════════════
//  7. Selected card styling
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-selected] selected card is visibly marked with inverted style", () => {
  const presented = present({
    blocks: [block({ kind: "tool", title: "read_file", body: "some output", id: "b1", finishedAt: "" })],
    selectedId: "b1",
    tokens: colorTokens,
  });
  const cardLine = presented[0].lines[0];
  // Selected styling applies theme.selected → SGR 7 (invert)
  assert.ok(cardLine.includes("\x1b[7m"), "selected card has invert styling");
});

test("[presenter-selected-user] selected user block gets inverted styling", () => {
  const presented = present({
    blocks: [block({ kind: "user", body: "hello", id: "b1" })],
    selectedId: "b1",
    tokens: colorTokens,
  });
  const firstLine = presented[0].lines[0];
  assert.ok(firstLine.includes("\x1b[7m"), "selected user header has invert");
});

test("[presenter-not-selected] non-selected block does not get invert styling", () => {
  const presented = present({
    blocks: [block({ kind: "tool", title: "read_file", body: "output", id: "b1", finishedAt: "" })],
    selectedId: "b2", // different from b1
    tokens: colorTokens,
  });
  const cardLine = presented[0].lines[0];
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(cardLine, /\x1b\[7m/, "non-selected block has no invert");
});

// ═════════════════════════════════════════════════════════════════════════════
//  8. Width bounding / narrow terminal
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-narrow-width] very narrow terminal produces non-overlapping truncated lines", () => {
  const body = "This is a very long line that should be truncated to fit a narrow terminal without wrapping or overlapping.";
  const presented = present({
    blocks: [block({ kind: "user", body, id: "b1" })],
    width: 10,
    tokens: plainTokens,
  });
  for (const line of presented[0].lines) {
    assert.ok(visibleWidth(line) <= 10, `narrow terminal: visibleWidth=${visibleWidth(line)} ≤ 10`);
  }
});

test("[presenter-width-bounding] all presented lines are width-bounded", () => {
  const presented = present({
    blocks: [
      block({ kind: "user", body: "Hello there", id: "b1" }),
      block({ kind: "assistant", body: "Hi, how can I help?", id: "b2" }),
      block({ kind: "system", body: "Running diagnostics...", id: "b3" }),
    ],
    width: 30,
    tokens: plainTokens,
  });
  for (const pb of presented) {
    for (const line of pb.lines) {
      assert.ok(visibleWidth(line) <= 30, `width=30: visibleWidth=${visibleWidth(line)}`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  9. No-color mode
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-plain-tokens] plain/no-color tokens produce no ANSI escape codes", () => {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[/;
  const presented = present({
    tokens: plainTokens,
    blocks: [
      block({ kind: "user", body: "hello", id: "b1" }),
      block({ kind: "assistant", body: "response", id: "b2" }),
      block({ kind: "system", body: "info", id: "b3" }),
      block({ kind: "tool", title: "rg", body: "3 matches", id: "b4", finishedAt: "" }),
      block({ kind: "check", title: "unit", body: "passed", id: "b5", finishedAt: "" }),
    ],
  });
  for (const pb of presented) {
    for (const line of pb.lines) {
      assert.doesNotMatch(line, ansi, `no ANSI in plain output: "${line}"`);
    }
  }
});

test("[presenter-plain-readable] plain output remains readable without ANSI codes", () => {
  const presented = present({
    tokens: plainTokens,
    blocks: [
      block({ kind: "user", body: "check tests", id: "b1" }),
      block({ kind: "assistant", body: "Running tests...", id: "b2" }),
    ],
  });
  const all = presented.flatMap((p) => p.lines).join(" ");
  assert.ok(all.includes("You"), "readable You header");
  assert.ok(all.includes("Deepcoder"), "readable Deepcoder header");
  assert.ok(all.includes("check tests"), "readable user body");
  assert.ok(all.includes("Running tests..."), "readable assistant body");
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Long label truncation
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-long-labels] long tool/check/worker labels truncate safely", () => {
  const longTitle = "a".repeat(200);
  const presented = present({
    blocks: [block({ kind: "tool", title: longTitle, body: "some output", id: "b1", finishedAt: "" })],
    width: 40,
    tokens: plainTokens,
  });
  for (const line of presented[0].lines) {
    assert.ok(visibleWidth(line) <= 40, `long label truncated to width: visibleWidth=${visibleWidth(line)}`);
  }
});

test("[presenter-long-body] long assistant body is truncated per line", () => {
  const veryLongLine = "x".repeat(500);
  const presented = present({
    blocks: [block({ kind: "assistant", body: veryLongLine, id: "b1" })],
    width: 30,
    tokens: plainTokens,
  });
  for (const line of presented[0].lines) {
    assert.ok(visibleWidth(line) <= 30, `long body line truncated: visibleWidth=${visibleWidth(line)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Secret redaction
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-secrets-redacted] no secret-looking strings appear unredacted in card previews", () => {
  const presented = present({
    // expanded so the card actually previews the body — the path where
    // secret redaction must take effect.
    blocks: [block({ kind: "tool", title: "rg", body: "api_key=sk-abcdefghijklmnop\nresult: ok", id: "b1", finishedAt: "", expanded: true })],
    tokens: plainTokens,
  });
  const all = presented.flatMap((p) => p.lines).join(" ");
  assert.ok(!all.includes("sk-abcdefghijklmnop"), "raw API key not present");
  // The redacted form should show something like api_key=*** or similar
  assert.ok(all.includes("***") || all.includes("[REDACTED]"), "redacted placeholder appears");
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Deterministic output
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-deterministic] same inputs produce identical presented blocks", () => {
  const input: PresentTranscriptInput = {
    blocks: [
      block({ kind: "user", body: "hello", id: "b1" }),
      block({ kind: "assistant", body: "world", id: "b2" }),
      block({ kind: "tool", title: "rg", body: "3 matches\nline2\nline3", id: "b3", finishedAt: "" }),
    ],
    width: 80,
    tokens: plainTokens,
  };
  const a = presentTranscript(input);
  const b = presentTranscript(input);
  assert.deepEqual(a, b, "deterministic output on identical input");
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Empty state via presentTranscript
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-empty-state-flag] presentTranscript with emptyState=true and no blocks returns empty greeting", () => {
  const result = presentTranscript({
    blocks: [],
    width: WIDE,
    tokens: plainTokens,
    emptyState: true,
  });
  assert.ok(result.length > 0, "empty state produces PresentedBlocks");
  assert.equal(result[0].id, "__empty__", "empty state block has sentinel id");
  assert.ok(result[0].lines.some((l) => l.includes("Deepcoder")), "empty state includes header");
});

test("[presenter-empty-state-no-blocks] presentTranscript with emptyState=false and no blocks returns empty array", () => {
  const result = presentTranscript({
    blocks: [],
    width: WIDE,
    tokens: plainTokens,
    emptyState: false,
  });
  assert.equal(result.length, 0, "no empty state when emptyState is false");
});

test("[presenter-empty-state-default] presentTranscript without emptyState flag and no blocks returns empty array", () => {
  const result = presentTranscript({
    blocks: [],
    width: WIDE,
    tokens: plainTokens,
  });
  assert.equal(result.length, 0, "no empty state by default");
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. Presenter — focusable flag
// ═════════════════════════════════════════════════════════════════════════════

test("[presenter-focusable] tool/check/worker blocks are focusable, others are not", () => {
  const presented = present({
    blocks: [
      block({ kind: "user", body: "hi", id: "b1" }),
      block({ kind: "assistant", body: "hello", id: "b2" }),
      block({ kind: "system", body: "info", id: "b3" }),
      block({ kind: "tool", title: "rg", body: "out", id: "b4", finishedAt: "" }),
      block({ kind: "check", title: "lint", body: "ok", id: "b5", finishedAt: "" }),
      block({ kind: "worker", title: "task", body: "done", id: "b6", finishedAt: "" }),
      block({ kind: "notice", body: "msg", id: "b7" }),
    ],
    tokens: plainTokens,
  });
  const focusable = presented.filter((p) => p.focusable).map((p) => p.id);
  assert.deepEqual(focusable, ["b4", "b5", "b6"], "only tool/check/worker are focusable");
});
