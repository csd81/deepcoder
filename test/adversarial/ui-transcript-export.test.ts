/**
 * Phase 10A.12 — Adversarial tests for the transcript Markdown formatter
 * and focused-block lookup.
 *
 * Covers:
 * - formatTranscriptBlockMarkdown: assistant/user as Markdown,
 *   tool/check/worker/approval as fenced text, redaction, body capping,
 *   malformed/empty fields.
 * - formatTranscriptMarkdown: full transcript ordering, empty transcript.
 * - selectedBlock: focused block lookup, stale id, null selection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptBlock, TranscriptState } from "../../src/ui/transcript.js";
import {
  formatTranscriptBlockMarkdown,
  formatTranscriptMarkdown,
  selectedBlock,
  type TranscriptExportOptions,
} from "../../src/ui/transcriptExport.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function block(overrides: Partial<TranscriptBlock> & { kind: TranscriptBlock["kind"] }): TranscriptBlock {
  return {
    id: overrides.id ?? "b1",
    body: overrides.body ?? "",
    startedAt: overrides.startedAt ?? "",
    title: overrides.title,
    refId: overrides.refId,
    collapsed: overrides.collapsed,
    expanded: overrides.expanded,
    isError: overrides.isError,
    finishedAt: overrides.finishedAt,
    ...overrides,
  };
}

function state(overrides?: Partial<TranscriptState>): TranscriptState {
  return {
    blocks: overrides?.blocks ?? [],
    status: overrides?.status ?? {},
    atBottom: overrides?.atBottom ?? true,
    hasNewOutputBelow: overrides?.hasNewOutputBelow ?? false,
    totalBytes: overrides?.totalBytes ?? 0,
    selectedBlockId: overrides?.selectedBlockId ?? null,
  };
}

// ── formatTranscriptBlockMarkdown ─────────────────────────────────────────────

test("[export-format-user] formats user block as inline Markdown (no fence)", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "user", body: "Hello world" }),
  );
  assert.match(result, /^## user\n\nHello world$/);
  assert.doesNotMatch(result, /```text/);
});

test("[export-format-assistant] formats assistant block as inline Markdown (no fence)", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "assistant", body: "Here is a summary" }),
  );
  assert.match(result, /^## assistant\n\nHere is a summary$/);
  assert.doesNotMatch(result, /```text/);
});

test("[export-format-tool] formats tool block as fenced text", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", title: "read_file", body: "file contents" }),
  );
  assert.match(result, /^## tool: read_file\n\n```text\nfile contents\n```$/);
});

test("[export-format-check] formats check block as fenced text", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "check", title: "lint", body: "PASS" }),
  );
  assert.match(result, /^## check: lint\n\n```text\nPASS\n```$/);
});

test("[export-format-worker] formats worker block as fenced text", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "worker", title: "deepseek", body: "status OK" }),
  );
  assert.match(result, /^## worker: deepseek\n\n```text\nstatus OK\n```$/);
});

test("[export-format-approval] formats approval block as fenced text", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "approval", title: "run tool", body: "+1 line" }),
  );
  assert.match(result, /^## approval: run tool\n\n```text\n\+1 line\n```$/);
});

test("[export-format-notice] formats notice block as inline Markdown", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "notice", body: "something happened" }),
  );
  assert.match(result, /^## notice\n\nsomething happened$/);
});

// ── Redaction ─────────────────────────────────────────────────────────────────

test("[export-redact] redacts key-shaped strings in block body", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", title: "read_file", body: "api_key=sk-secret1234abc" }),
  );
  assert.doesNotMatch(result, /sk-secret1234abc/);
  // The sk- regex runs first (→ sk-***), then the api_key regex
  // replaces the whole thing (→ api_key=***).
  assert.match(result, /api_key=\*\*\*/);
  assert.doesNotMatch(result, /sk-\*\*\*/);
});

test("[export-redact] redacts bearer tokens", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "assistant", body: "Use Bearer mytoken123" }),
  );
  assert.doesNotMatch(result, /mytoken123/);
  assert.match(result, /Bearer \*\*\*/);
});

// ── Body capping ──────────────────────────────────────────────────────────────

test("[export-cap-blocks] caps body over maxBlockChars and marks truncated", () => {
  const longBody = "x".repeat(60_000);
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", title: "huge", body: longBody }),
    { maxBlockChars: 10_000 },
  );
  // Only 10_000 chars + header + fences + truncated marker
  assert.equal(result.length < 15_000, true, "result should be much shorter than 60k");
  assert.match(result, /\*\(truncated\)\*/);
  // Verify the truncated body length
  const afterFence = result.indexOf("```text\n") + 8;
  const beforeClosing = result.indexOf("\n```\n", afterFence);
  const bodySlice = result.slice(afterFence, beforeClosing);
  assert.equal(bodySlice.length, 10_000, "body should be capped to maxBlockChars");
});

test("[export-cap-blocks] short body is not truncated", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "assistant", body: "short" }),
    { maxBlockChars: 50_000 },
  );
  assert.doesNotMatch(result, /\*\(truncated\)\*/);
});

// ── Malformed / empty fields ──────────────────────────────────────────────────

test("[export-malformed] nullish/empty body never throws", () => {
  assert.doesNotThrow(() => {
    formatTranscriptBlockMarkdown(
      // @ts-expect-error — testing resilience to badly-formed data
      { kind: "user", body: undefined, id: "b1", startedAt: "" },
    );
  });
  assert.doesNotThrow(() => {
    formatTranscriptBlockMarkdown(
      block({ kind: "user", body: "" }),
    );
  });
});

test("[export-malformed] missing title still formats", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", body: "output" }),
  );
  assert.match(result, /^## tool\n/);
});

test("[export-malformed] empty blocks array is handled by full formatter", () => {
  assert.equal(formatTranscriptMarkdown([]), "");
});

// ── formatTranscriptMarkdown ──────────────────────────────────────────────────

test("[export-full-transcript] includes all blocks in order", () => {
  const blocks: TranscriptBlock[] = [
    block({ kind: "user", body: "Hello", id: "b1" }),
    block({ kind: "assistant", body: "Hi!", id: "b2" }),
    block({ kind: "tool", title: "grep", body: "results", id: "b3" }),
  ];
  const result = formatTranscriptMarkdown(blocks);

  // Should contain all block headers in order
  const lines = result.split("\n");
  const headings = lines.filter((l) => l.startsWith("## "));
  assert.equal(headings.length, 3);
  assert.equal(headings[0], "## user");
  assert.equal(headings[1], "## assistant");
  assert.equal(headings[2], "## tool: grep");
});

test("[export-full-transcript] empty transcript returns empty string", () => {
  assert.equal(formatTranscriptMarkdown([]), "");
});

test("[export-full-transcript] nullish blocks array returns empty string", () => {
  // @ts-expect-error — testing resilience
  assert.equal(formatTranscriptMarkdown(null), "");
});

test("[export-full-transcript] blocks separated by blank line", () => {
  const blocks: TranscriptBlock[] = [
    block({ kind: "user", body: "a", id: "b1" }),
    block({ kind: "assistant", body: "b", id: "b2" }),
  ];
  const result = formatTranscriptMarkdown(blocks);
  assert.match(result, /user.*\n\n.*assistant/s);
});

// ── includeTimestamps option ──────────────────────────────────────────────────

test("[export-timestamps] includeTimestamps appends timestamp to heading", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", title: "read_file", body: "x", startedAt: "2026-01-01T00:00:00Z" }),
    { includeTimestamps: true },
  );
  assert.match(result, /started at 2026-01-01T00:00:00Z/);
});

test("[export-timestamps] no timestamp when not requested", () => {
  const result = formatTranscriptBlockMarkdown(
    block({ kind: "tool", title: "read_file", body: "x", startedAt: "2026-01-01T00:00:00Z" }),
  );
  assert.doesNotMatch(result, /started at/);
});

// ── selectedBlock ─────────────────────────────────────────────────────────────

test("[export-selected-block] returns the focused block by id", () => {
  const b = block({ kind: "tool", title: "grep", body: "matches", id: "b2" });
  const s = state({
    blocks: [
      block({ kind: "user", body: "hi", id: "b1" }),
      b,
    ],
    selectedBlockId: "b2",
  });
  assert.deepEqual(selectedBlock(s), b);
});

test("[export-selected-block] returns null when no block is selected", () => {
  const s = state({
    blocks: [block({ kind: "user", body: "hi", id: "b1" })],
    selectedBlockId: null,
  });
  assert.equal(selectedBlock(s), null);
});

test("[export-selected-block] returns null when selectedBlockId is stale", () => {
  const s = state({
    blocks: [block({ kind: "user", body: "hi", id: "b1" })],
    selectedBlockId: "nonexistent",
  });
  assert.equal(selectedBlock(s), null);
});
