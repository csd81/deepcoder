/**
 * Patch Review Browser — pure controller (key map + reducer + setters).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewKeyToAction,
  reduceReview,
  initReviewState,
  applyVerify,
  applyMessage,
  refreshDetail,
  diffWidthFor,
  bodyHeightFor,
} from "../../src/ui/reviewController.js";
import type { WorkerReviewDetail } from "../../src/delegate/reviewBrowser.js";

function detail(over: Partial<WorkerReviewDetail> = {}): WorkerReviewDetail {
  return {
    workerId: "w1", title: "fix bug", status: "passed", checkPassed: true,
    changedFiles: ["src/a.ts", "src/b.ts"], patchBytes: 100, qualityGate: "pass",
    deterministicGates: [{ name: "tdd_gate", passed: true, message: "green_confirmed" }],
    applyEligible: true, applyBlockers: [], promptPreview: "", summary: "",
    patchStat: [{ path: "src/a.ts", added: 1, removed: 1, kind: "modified" }, { path: "src/b.ts", added: 1, removed: 0, kind: "modified" }],
    patchPreview: [
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-x", "+y",
      "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -0,0 +1 @@", "+z",
    ].join("\n"),
    artifactPaths: {}, ...over,
  };
}
const CTX = { bodyHeight: 3, diffWidth: 80 };

test("reviewKeyToAction maps the documented keys in diff mode", () => {
  assert.equal(reviewKeyToAction("j", "diff"), "scroll-down");
  assert.equal(reviewKeyToAction("k", "diff"), "scroll-up");
  assert.equal(reviewKeyToAction("n", "diff"), "next-file");
  assert.equal(reviewKeyToAction("p", "diff"), "prev-file");
  assert.equal(reviewKeyToAction("v", "diff"), "verify");
  assert.equal(reviewKeyToAction("o", "diff"), "open");
  assert.equal(reviewKeyToAction("q", "diff"), "quit");
  assert.equal(reviewKeyToAction("escape", "diff"), "quit");
  assert.equal(reviewKeyToAction("pagedown", "diff"), "scroll-down");
  assert.equal(reviewKeyToAction("x", "diff"), "none");
});

test("in message mode any key dismisses the banner", () => {
  assert.equal(reviewKeyToAction("j", "message"), "dismiss");
  assert.equal(reviewKeyToAction("q", "message"), "dismiss");
});

test("initReviewState splits the patch into files, selected/scroll at 0", () => {
  const s = initReviewState(detail(), "/tmp/wt");
  assert.equal(s.files.length, 2);
  assert.equal(s.files[0]!.path, "src/a.ts");
  assert.equal(s.selected, 0);
  assert.equal(s.scroll, 0);
  assert.equal(s.mode, "diff");
  assert.equal(s.worktreePath, "/tmp/wt");
});

test("scroll clamps to [0, maxScroll] and never goes negative or past end", () => {
  let s = initReviewState(detail());
  s = reduceReview(s, "scroll-up", CTX);
  assert.equal(s.scroll, 0, "cannot scroll above the top");
  // file 0 has 6 diff lines, bodyHeight 3 -> maxScroll 3
  for (let i = 0; i < 10; i++) s = reduceReview(s, "scroll-down", { bodyHeight: 3, diffWidth: 80 });
  assert.equal(s.scroll, 3, "clamped to maxScroll (6 lines - 3 body)");
});

test("next/prev-file clamps selection and resets scroll", () => {
  let s = initReviewState(detail());
  s = reduceReview(s, "scroll-down", CTX); // scroll the first file
  s = reduceReview(s, "next-file", CTX);
  assert.equal(s.selected, 1);
  assert.equal(s.scroll, 0, "scroll resets on file change");
  s = reduceReview(s, "next-file", CTX);
  assert.equal(s.selected, 1, "clamped at last file");
  s = reduceReview(s, "prev-file", CTX);
  s = reduceReview(s, "prev-file", CTX);
  assert.equal(s.selected, 0, "clamped at first file");
});

test("applyVerify sets a message summarizing the validation verdict", () => {
  const s0 = initReviewState(detail());
  const s = applyVerify(s0, { status: "invalid", applyable: false, evaluatedAt: "", failures: [{ code: "test_only_change", message: "x", source: "completeness" }], warnings: [], evidence: [] } as never);
  assert.equal(s.mode, "message");
  assert.match(s.message!.text, /invalid|not applyable|1 failure/i);
  assert.equal(s.message!.isError, true);
  // dismiss returns to diff
  const back = reduceReview(s, "dismiss", CTX);
  assert.equal(back.mode, "diff");
});

test("applyMessage shows a banner; refreshDetail re-splits and clamps selection", () => {
  let s = initReviewState(detail());
  s = reduceReview(s, "next-file", CTX); // selected = 1
  s = applyMessage(s, "/tmp/worktree", false);
  assert.equal(s.mode, "message");
  assert.equal(s.message!.text, "/tmp/worktree");
  // refresh to a single-file detail -> selected clamps to 0
  const one = detail({ patchPreview: "diff --git a/only.ts b/only.ts\n--- a/only.ts\n+++ b/only.ts\n@@ -1 +1 @@\n-a\n+b" });
  s = refreshDetail(s, one);
  assert.equal(s.files.length, 1);
  assert.equal(s.selected, 0);
});

test("layout helpers: narrow terminal drops the list column", () => {
  assert.equal(bodyHeightFor(24), 21); // 24 - status(2) - footer(1)
  assert.ok(diffWidthFor(120) < 120 && diffWidthFor(120) > 60, "wide: list + diff split");
  assert.equal(diffWidthFor(50), 50, "narrow (<60): full-width diff, no list column");
});
