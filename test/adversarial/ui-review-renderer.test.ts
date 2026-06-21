/**
 * Patch Review Browser — pure renderer (frame string[] from state+size+theme).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initReviewState, renderReview, applyMessage } from "../../src/ui/reviewController.js";
import { createTheme } from "../../src/ui/theme.js";
import { visibleWidth } from "../../src/ui/minimalRenderer.js";
import type { WorkerReviewDetail } from "../../src/delegate/reviewBrowser.js";

function detail(over: Partial<WorkerReviewDetail> = {}): WorkerReviewDetail {
  return {
    workerId: "w1", title: "fix the parser", status: "passed", checkPassed: true,
    changedFiles: ["src/a.ts", "src/b.ts"], patchBytes: 2048, qualityGate: "pass",
    deterministicGates: [{ name: "tdd_gate", passed: true, message: "green_confirmed" }, { name: "quality_gate", passed: true, message: "ok" }],
    applyEligible: true, applyBlockers: [], promptPreview: "", summary: "",
    patchStat: [{ path: "src/a.ts", added: 1, removed: 1, kind: "modified" }, { path: "src/b.ts", added: 1, removed: 0, kind: "modified" }],
    patchPreview: [
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old line", "+new line",
      "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -0,0 +1 @@", "+added",
    ].join("\n"),
    artifactPaths: {}, ...over,
  };
}
const SIZE = { width: 100, height: 20 };

test("frame is exactly height rows, each <= width visible columns", () => {
  const frame = renderReview(initReviewState(detail()), SIZE, createTheme(true));
  assert.equal(frame.length, SIZE.height);
  for (const row of frame) assert.ok(visibleWidth(row) <= SIZE.width, `row too wide: ${visibleWidth(row)}`);
});

test("status bar surfaces worker/status/check/quality/TDD/files/size/apply", () => {
  const text = renderReview(initReviewState(detail()), SIZE, createTheme(false)).join("\n");
  assert.match(text, /w1/);
  assert.match(text, /passed/);
  assert.match(text, /check/i);
  assert.match(text, /quality/i);
  assert.match(text, /tdd/i);
  assert.match(text, /2 file/i);
  assert.match(text, /apply/i);
});

test("a BLOCKED, ineligible worker shows the first blocker", () => {
  const d = detail({ applyEligible: false, applyBlockers: ["check did not pass", "patch out of scope"], checkPassed: false });
  const text = renderReview(initReviewState(d), SIZE, createTheme(false)).join("\n");
  assert.match(text, /BLOCKED/);
  assert.match(text, /check did not pass/);
});

test("the selected file row is reverse-video; the diff body colorizes +/-/@@", () => {
  const frame = renderReview(initReviewState(detail()), SIZE, createTheme(true));
  const joined = frame.join("\n");
  assert.ok(joined.includes("\x1b[7m"), "selected file row uses reverse-video (theme.selected)");
  assert.ok(joined.includes("\x1b[32m"), "an added (+) line is green");
  assert.ok(joined.includes("\x1b[31m"), "a removed (-) line is red");
});

test("color disabled => no SGR escape codes anywhere", () => {
  const frame = renderReview(initReviewState(detail()), SIZE, createTheme(false));
  for (const row of frame) assert.ok(!/\x1b\[/.test(row), "no ANSI codes when color is off");
});

test("message mode renders the banner text", () => {
  const s = applyMessage(initReviewState(detail()), "/tmp/worktree-abc", false);
  const text = renderReview(s, SIZE, createTheme(false)).join("\n");
  assert.match(text, /\/tmp\/worktree-abc/);
});

test("narrow terminal (<60 cols) still renders height rows within width", () => {
  const frame = renderReview(initReviewState(detail()), { width: 50, height: 16 }, createTheme(true));
  assert.equal(frame.length, 16);
  for (const row of frame) assert.ok(visibleWidth(row) <= 50);
});
