/**
 * Phase 10A.16 — Block Preview (pure module) adversarial tests.
 *
 * Covers the plan's test bullets for the blockPreview.ts module:
 *  1. tool with 3 lines summarizes as "3 lines"
 *  2. huge tool output caps preview lines
 *  3. error tool status is "error"
 *  4. running tool status is "running"
 *  5. check passed status is "success"
 *  6. check failed status is "error" and prefers failure line
 *  7. worker summary uses final status line
 *  8. secrets are redacted
 *  9. empty body never throws
 * 10. output preview is bounded
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBlockPreview,
  type BlockPreviewOptions,
} from "../../src/ui/blockPreview.js";
import type { TranscriptBlock } from "../../src/ui/transcript.js";

// ── Fixture builders ───────────────────────────────────────────────────────

function toolBlock(overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    id: "b1",
    kind: "tool",
    title: "read_file",
    body: "",
    startedAt: "",
    ...overrides,
  };
}

function checkBlock(overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    id: "b2",
    kind: "check",
    title: "unit",
    body: "",
    startedAt: "",
    ...overrides,
  };
}

function workerBlock(overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    id: "b3",
    kind: "worker",
    title: "delegate",
    body: "",
    startedAt: "",
    ...overrides,
  };
}

// ── 1. Tool with 3 lines summarizes as "3 lines" ───────────────────────────

test("[blockPreview-tool-3lines] tool with 3 lines summarizes as 3 lines", () => {
  const block = toolBlock({
    body: "line one\nline two\nline three",
    finishedAt: "",
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.title, "tool read_file");
  assert.equal(preview.lineCount, 3);
  assert.equal(preview.summary, "3 lines");
  assert.equal(preview.status, "neutral");
});

// ── 2. Huge tool output caps preview lines ─────────────────────────────────

test("[blockPreview-tool-huge] huge tool output caps preview lines", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`line ${i + 1}`);
  }
  const block = toolBlock({
    body: lines.join("\n"),
    finishedAt: "",
  });
  const preview = buildBlockPreview(block, { maxPreviewLines: 3 });
  assert.equal(preview.lineCount, 100);
  assert.ok(preview.previewLines.length <= 3, "preview lines capped at maxPreviewLines");
  assert.equal(preview.previewLines.length, 3, "takes 3 meaningful lines");
  assert.equal(preview.truncated, true, "truncated flag is true");
  assert.equal(preview.summary, "100 lines");
});

// ── 3. Error tool status is "error" ────────────────────────────────────────

test("[blockPreview-tool-error] error tool status is error", () => {
  const block = toolBlock({
    body: "Error: something went wrong\n  at foo (bar.ts:42)",
    isError: true,
    finishedAt: "",
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "error");
  assert.equal(preview.title, "tool read_file");
  assert.ok(preview.summary.includes("Error:"), "summary surfaces failure line");
});

// ── 4. Running tool status is "running" ────────────────────────────────────

test("[blockPreview-tool-running] running tool status is running", () => {
  // A tool_start block: no finishedAt, empty body → running
  const block = toolBlock({ body: "" }); // no finishedAt
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "running");
  assert.equal(preview.summary, "0 lines");
  assert.equal(preview.previewLines.length, 0);
});

// ── 5. Check passed status is "success" ────────────────────────────────────

test("[blockPreview-check-passed] check passed status is success", () => {
  const block = checkBlock({
    body: "tests: 42\n42 passed\n0 failed",
    finishedAt: "",
    isError: false,
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "success");
  assert.equal(preview.title, "check unit");
  assert.ok(preview.summary.includes("passed"), "summary mentions passed count");
  assert.equal(preview.summary, "42 passed");
});

// ── 6. Check failed status is "error" and prefers failure line ─────────────

test("[blockPreview-check-failed] check failed status is error and prefers failure line", () => {
  const block = checkBlock({
    body: "RUNS  tests\nFAILED test/foo.test.ts:42\n  Expected 1, got 0\n",
    finishedAt: "",
    isError: true,
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "error");
  assert.ok(preview.summary.includes("FAILED"), "summary prefers failure-looking line");
  // Preview lines should include the FAILED line
  assert.ok(
    preview.previewLines.some((l) => l.includes("FAILED")),
    "previewLines include failure line",
  );
});

// ── 7. Worker summary uses last non-empty line of body ─────────────────────

test("[blockPreview-worker-summary] worker summary uses final status line", () => {
  const block = workerBlock({
    body: "Attempt 1/3\nRunning checks...\nsolved in 2 attempts, 3 files changed",
    finishedAt: "",
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "success");
  assert.equal(preview.title, "worker delegate");
  assert.ok(
    preview.summary.includes("solved in"),
    "summary uses last non-empty line",
  );
  assert.ok(
    preview.summary.includes("3 files changed"),
    "summary captures full final line",
  );
});

// ── 8. Secrets are redacted ────────────────────────────────────────────────

test("[blockPreview-secrets] secrets are redacted from preview and summary", () => {
  const block = toolBlock({
    body: "using api_key=sk-abcdefghijklmnop\nresult: ok",
    finishedAt: "",
    isError: false,
  });
  const preview = buildBlockPreview(block);
  // The full raw key must not appear in summary or preview lines
  assert.ok(!preview.summary.includes("sk-abcdefghijklmnop"), "summary redacts API key");
  for (const line of preview.previewLines) {
    assert.ok(!line.includes("sk-abcdefghijklmnop"), "preview lines redact API key");
  }
  // The redacted form should be present (redactSecrets cascades: sk-... → sk-*** → api_key=***)
  const allText = preview.summary + " " + preview.previewLines.join(" ");
  assert.ok(allText.includes("api_key=***"), "redacted key placeholder appears");
});

// ── 9. Empty body never throws ─────────────────────────────────────────────

test("[blockPreview-empty-body] empty body never throws for any kind", () => {
  const kinds: TranscriptBlock["kind"][] = ["tool", "check", "worker", "assistant", "notice", "approval", "system"];
  for (const kind of kinds) {
    const block: TranscriptBlock = {
      id: "b0",
      kind,
      body: "",
      startedAt: "",
    };
    const preview = buildBlockPreview(block);
    assert.equal(typeof preview.title, "string", `title is string for kind=${kind}`);
    assert.equal(typeof preview.summary, "string", `summary is string for kind=${kind}`);
    assert.ok(Array.isArray(preview.previewLines), `previewLines is array for kind=${kind}`);
    assert.equal(typeof preview.lineCount, "number", `lineCount is number for kind=${kind}`);
  }
});

// ── 10. Output preview is bounded ──────────────────────────────────────────

test("[blockPreview-bounded] output preview lines and chars are bounded", () => {
  const longLine = "word ".repeat(500); // well over 200 chars
  const manyLines: string[] = [];
  for (let i = 0; i < 20; i++) {
    manyLines.push(`${longLine} ${i}`);
  }
  const block = toolBlock({
    body: manyLines.join("\n"),
    finishedAt: "",
  });
  const opts: BlockPreviewOptions = { maxPreviewLines: 2, maxPreviewChars: 50 };
  const preview = buildBlockPreview(block, opts);

  // maxPreviewLines cap
  assert.ok(
    preview.previewLines.length <= opts.maxPreviewLines!,
    "previewLines count capped",
  );

  // maxPreviewChars cap per line
  for (const line of preview.previewLines) {
    assert.ok(
      line.length <= opts.maxPreviewChars!,
      `each preview line is capped at ${opts.maxPreviewChars} chars (got ${line.length})`,
    );
  }

  assert.equal(preview.truncated, true, "truncated when body has more lines than preview");

  // Sanity: block with few lines should NOT be truncated
  const short = toolBlock({
    body: "a\nb",
    finishedAt: "",
  });
  assert.equal(buildBlockPreview(short, opts).truncated, false);
});

// ── Additional edge cases ──────────────────────────────────────────────────

test("[blockPreview-check-summary-extract] check summary extracts test counters", () => {
  const block = checkBlock({
    body: "some setup\n12 passed\n3 failed\ntests: 15",
    finishedAt: "",
    isError: false,
  });
  const preview = buildBlockPreview(block);
  assert.ok(preview.summary.includes("12 passed"), "extracts passed count");
  assert.ok(preview.summary.includes("3 failed"), "extracts failed count");
});

test("[blockPreview-worker-running] worker without finishedAt is running", () => {
  const block = workerBlock({ body: "still working…" }); // no finishedAt
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "running");
  assert.equal(preview.summary, "still working…");
});

test("[blockPreview-worker-error] worker with isError is error", () => {
  const block = workerBlock({
    body: "Task failed",
    finishedAt: "",
    isError: true,
  });
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "error");
});

test("[blockPreview-check-running] check without finishedAt is running", () => {
  const block = checkBlock({ body: "running tests…" }); // no finishedAt
  const preview = buildBlockPreview(block);
  assert.equal(preview.status, "running");
});

test("[blockPreview-default-options] default options give 3 preview lines / 200 chars", () => {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(`line ${i}`);
  const block = toolBlock({ body: lines.join("\n"), finishedAt: "" });
  const preview = buildBlockPreview(block);
  assert.equal(preview.previewLines.length, 3, "default 3 preview lines");
  for (const l of preview.previewLines) {
    assert.ok(l.length <= 200, `default 200 char cap (got ${l.length})`);
  }
});

test("[blockPreview-grep-tool-summary] grep tool with file:line output shows match count", () => {
  const block = toolBlock({
    title: "rg",
    body: "src/foo.ts:10:some code\nsrc/bar.ts:20:more code\nsrc/baz.ts:30:extra",
    finishedAt: "",
  });
  const preview = buildBlockPreview(block);
  // Should detect grep-like output and show match count
  assert.ok(preview.summary.includes("matches"), "summary includes 'matches' for grep output");
});
