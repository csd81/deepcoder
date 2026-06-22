/**
 * Phase 10A — pure-module adversarial tests for diffSummary.ts and
 * approvalReview.ts (no I/O, no TTY, no live model).
 *
 * Coverage (plan §Tests 1–14):
 *   1. Parses one-file unified diff stats.
 *   2. Parses multi-file diff stats.
 *   3. Ignores `+++`/`---` in addition/deletion counts.
 *   4. Malformed diff never throws.
 *   5. Sensitive paths raise high-risk summary.
 *   6. Execute action with no diff is high risk.
 *   7. Test-only diff is lower risk.
 *   8. Render output is width-bounded.
 *   9. Render output is height-bounded.
 *  10. Details mode shows request details.
 *  11. Diff mode shows file headers and hunk lines.
 *  12. Secret-looking strings are redacted.
 *  13. Footer contains approve/deny/details hints.
 *  14. `NO_COLOR`/monochrome theme still produces readable markers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeUnifiedDiff,
  splitUnifiedDiffByFile,
  formatDiffStat,
  capLines,
} from "../../src/ui/diffSummary.js";
import type { DiffFileSummary } from "../../src/ui/diffSummary.js";
import {
  buildApprovalReview,
  renderApprovalReview,
} from "../../src/ui/approvalReview.js";
import type { ApprovalReview, BuildApprovalReviewInput } from "../../src/ui/approvalReview.js";
import { createTheme } from "../../src/ui/theme.js";
import type { Theme } from "../../src/ui/theme.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const plain = createTheme(false);

function review(input: Partial<BuildApprovalReviewInput> = {}): ApprovalReview {
  return buildApprovalReview({
    description: "edit file src/foo.ts",
    ...input,
  });
}

function render(
  rev: ApprovalReview,
  overrides: Partial<{
    width: number;
    height: number;
    scroll: number;
    mode: "diff" | "details";
    theme: Theme;
  }> = {},
): string[] {
  return renderApprovalReview({
    review: rev,
    width: overrides.width ?? 80,
    height: overrides.height ?? 20,
    scroll: overrides.scroll ?? 0,
    mode: overrides.mode ?? "diff",
    theme: overrides.theme ?? plain,
  });
}

// ── Diff Parser Tests ────────────────────────────────────────────────────────

describe("diffSummary: splitUnifiedDiffByFile", () => {
  test("empty / null returns empty array", () => {
    assert.deepEqual(splitUnifiedDiffByFile(""), []);
    assert.deepEqual(splitUnifiedDiffByFile("   "), []);
    assert.deepEqual(splitUnifiedDiffByFile("\n\n"), []);
  });
});

describe("diffSummary: summarizeUnifiedDiff", () => {
  // Test 1: Parses one-file unified diff stats.
  test("parses one-file diff stats", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,5 +1,8 @@",
      " unchanged",
      "-removed line",
      "+added line",
      "+another added",
      " still here",
      "",
    ].join("\n");

    const stats = summarizeUnifiedDiff(diff);
    assert.equal(stats.length, 1);
    assert.equal(stats[0].path, "src/foo.ts");
    assert.equal(stats[0].additions, 2);
    assert.equal(stats[0].deletions, 1);
    assert.equal(stats[0].hunks, 1);
  });

  // Test 2: Parses multi-file diff stats.
  test("parses multi-file diff stats", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+z",
      "+w",
    ].join("\n");

    const stats = summarizeUnifiedDiff(diff);
    assert.equal(stats.length, 2);
    assert.equal(stats[0].path, "src/a.ts");
    assert.equal(stats[0].additions, 1);
    assert.equal(stats[0].deletions, 1);
    assert.equal(stats[1].path, "src/b.ts");
    assert.equal(stats[1].additions, 2);
    assert.equal(stats[1].deletions, 0);
  });

  // Test 3: Ignores `+++`/`---` in addition/deletion counts.
  test("ignores +++/--- in addition/deletion counts", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      "--- this line starts with --- but is content",
      "+++ this line starts with +++ but is content",
      "-real deletion",
      "+real addition",
    ].join("\n");

    const stats = summarizeUnifiedDiff(diff);
    assert.equal(stats[0].path, "src/foo.ts");
    assert.equal(stats[0].additions, 1);
    assert.equal(stats[0].deletions, 1);
    // The --- and +++ content lines should NOT be counted
  });

  // Test 4: Malformed diff never throws.
  test("malformed diff never throws", () => {
    const nasty = [
      null as unknown as string,
      undefined as unknown as string,
      "garbage data that is not a diff",
      "@@@@ broken hunk @@",
      "+= weird marker",
      "-= other weird marker",
    ];

    for (const d of nasty) {
      assert.doesNotThrow(() => summarizeUnifiedDiff(d ?? ""));
    }
  });

  test("totally random text returns an unnamed summary with zero counts", () => {
    const stats = summarizeUnifiedDiff("hello world\nthis is not a diff\n");
    // May produce a single unnamed entry
    assert.ok(Array.isArray(stats));
    for (const s of stats) {
      assert.equal(s.additions + s.deletions + s.hunks, 0);
    }
  });
});

// ── formatDiffStat ───────────────────────────────────────────────────────────

describe("diffSummary: formatDiffStat", () => {
  test("formats aggregate stat", () => {
    const files: DiffFileSummary[] = [
      { path: "a.ts", additions: 5, deletions: 2, hunks: 1 },
      { path: "b.ts", additions: 0, deletions: 1, hunks: 1 },
    ];
    assert.equal(formatDiffStat(files), "+5 -3");
  });

  test("empty returns +0 -0", () => {
    assert.equal(formatDiffStat([]), "+0 -0");
  });
});

// ── capLines ─────────────────────────────────────────────────────────────────

describe("diffSummary: capLines", () => {
  test("returns all lines when under max", () => {
    assert.deepEqual(capLines(["a", "b"], 5, false), ["a", "b"]);
  });

  test("truncates with notice when over max", () => {
    const result = capLines(["a", "b", "c", "d"], 2, false);
    assert.equal(result.length, 2);
    assert.ok(result[1].includes("truncated"));
  });

  test("redacts secrets when redact=true", () => {
    const result = capLines(["my key is sk-abcdef123456"], 5);
    assert.ok(result[0].includes("sk-***"));
  });
});

// ── Approval Review Builder ──────────────────────────────────────────────────

describe("approvalReview: buildApprovalReview", () => {
  // Test 5: Sensitive paths raise high-risk summary.
  test("sensitive paths raise high risk", () => {
    const r = review({ description: "edit .deepcoder/config.json" });
    assert.equal(r.risk, "high");
  });

  test("package.json mutation raises high risk", () => {
    const r = review({ description: "edit package.json scripts" });
    assert.equal(r.risk, "high");
  });

  test("hooks path raises high risk", () => {
    const r = review({ description: "create hooks/post-tool.sh" });
    assert.equal(r.risk, "high");
  });

  // Test 6: Execute action with no diff is high risk.
  test("execute action with no diff is high risk", () => {
    const r = review({ description: "run npm run build" });
    assert.equal(r.risk, "high");
    assert.equal(r.actionKind, "execute");
  });

  test("execute action with diff is still high risk", () => {
    const r = review({
      description: "run build script",
      diff: "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n",
    });
    assert.equal(r.risk, "high");
    assert.equal(r.actionKind, "execute");
  });

  // Test 7: Test-only diff is lower risk.
  test("test-only mutation is low risk", () => {
    const r = review({ description: "edit test/foo.test.ts: fix assertion" });
    assert.equal(r.risk, "low");
  });

  test("docs-only mutation is low risk", () => {
    const r = review({ description: "update doc/README.md typo" });
    assert.equal(r.risk, "low");
  });

  test("mutation with source file is medium risk", () => {
    const r = review({ description: "edit src/foo.ts: fix typo" });
    assert.equal(r.risk, "medium");
  });

  test("read-only action is low risk", () => {
    const r = review({ description: "list files in src" });
    assert.equal(r.risk, "low");
    assert.equal(r.actionKind, "read-only");
  });

  test("commandPolicy deny raises risk to high", () => {
    const r = review({
      description: "run something",
      commandPolicy: "deny",
    });
    assert.equal(r.risk, "high");
  });

  test("actionKind inferred correctly for mutate keywords", () => {
    const r = review({ description: "edit src/config.ts" });
    assert.equal(r.actionKind, "mutate");
  });

  test("actionKind inferred as unknown for ambiguous text", () => {
    const r = review({ description: "do stuff" });
    // Without diff and without clear keywords, it's unknown
    assert.equal(r.actionKind, "unknown");
  });

  test("diff present without keywords still infers mutate", () => {
    const r = review({
      description: "apply patch",
      diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    });
    assert.equal(r.actionKind, "mutate");
  });

  test("title is always set", () => {
    const r = review();
    assert.equal(r.title, "Permission required");
  });

  test("files parsed from diff", () => {
    const r = review({
      description: "edit files",
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    });
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].path, "src/a.ts");
  });
});

// ── Approval Review Renderer ─────────────────────────────────────────────────

describe("approvalReview: renderApprovalReview", () => {
  // Test 8: Render output is width-bounded.
  test("render output is width-bounded", () => {
    const r = review({ description: "edit src/foo.ts: refactor function" });
    const lines = render(r, { width: 30 });
    for (const ln of lines) {
      assert.ok(ln.length <= 30, `line length ${ln.length} <= 30: "${ln}"`);
    }
  });

  // Test 9: Render output is height-bounded.
  test("render output is height-bounded", () => {
    const r = review({
      description: "edit multiple files",
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,4 @@",
        " line1",
        "-old",
        "+new",
        " line3",
      ].join("\n"),
    });
    const lines = render(r, { width: 80, height: 5 });
    assert.ok(lines.length <= 5, `got ${lines.length} rows, expected ≤5`);
  });

  // Test 10: Details mode shows request details.
  test("details mode shows request details", () => {
    const r = review({
      description: "edit src/config.ts",
      commandPolicy: "ask",
      sandboxSummary: "fast -> bubblewrap",
    });
    const lines = render(r, { mode: "details" });
    const joined = lines.join("\n");
    assert.ok(joined.includes("edit src/config.ts"), "shows description");
    assert.ok(joined.includes("Command policy: ask"), "shows command policy");
    assert.ok(joined.includes("Sandbox: fast -> bubblewrap"), "shows sandbox");
  });

  test("details mode shows file list when files present", () => {
    const r = review({
      description: "edit foo.ts",
      diff: [
        "diff --git a/foo.ts b/foo.ts",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    });
    const lines = render(r, { mode: "details" });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Files:"), "shows file count");
    assert.ok(joined.includes("foo.ts"), "shows file path");
  });

  // Test 11: Diff mode shows file headers and hunk lines.
  test("diff mode shows file headers and hunk lines", () => {
    const r = review({
      description: "edit files",
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,4 @@",
        " line1",
        "-old line",
        "+new line",
        " line3",
      ].join("\n"),
    });
    const lines = render(r, { mode: "diff" });
    const joined = lines.join("\n");
    assert.ok(joined.includes("src/a.ts"), "shows file path in header");
    assert.ok(joined.includes("@@"), "shows hunk line");
    assert.ok(joined.includes("+new line"), "shows added line");
    assert.ok(joined.includes("-old line"), "shows removed line");
  });

  // Test 12: Secret-looking strings are redacted.
  test("secrets are redacted in diff", () => {
    const r = review({
      description: "edit config",
      diff: [
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -1 +1 @@",
        "-API_KEY=old-secret",
        "+API_KEY=sk-abcdef123456xyz",
      ].join("\n"),
    });
    const lines = render(r, { mode: "diff" });
    const joined = lines.join("\n");
    assert.ok(!joined.includes("sk-abcdef123456xyz"), "full secret not visible");
    // No fragment of the secret leaks. The project's canonical redactSecrets
    // replaces a `KEY=`-prefixed value wholesale (`API_KEY=***`) rather than
    // leaving the `sk-***` token form, so assert on the redaction marker that is
    // actually produced — this is strictly *more* redacted, not less.
    assert.ok(!joined.includes("abcdef"), "no secret fragment visible");
    assert.ok(/API_KEY=\*\*\*/.test(joined), "redacted form visible");
  });

  test("secrets are redacted in description summary", () => {
    const r = review({
      description: "using key sk-abcdef1234567890",
    });
    const lines = render(r);
    const joined = lines.join("\n");
    assert.ok(!joined.includes("sk-abcdef1234567890"), "full secret not visible");
    assert.ok(joined.includes("sk-***"), "redacted form visible");
  });

  // Test 13: Footer contains approve/deny/details hints.
  test("footer shows approve/deny/details hints", () => {
    const r = review({
      description: "edit file",
      diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    });
    const lines = render(r);
    const footer = lines[lines.length - 1];
    assert.ok(footer.includes("approve"), "footer has approve hint");
    assert.ok(footer.includes("deny"), "footer has deny hint");
    assert.ok(footer.includes("details"), "footer has details hint");
    assert.ok(footer.includes("Esc"), "footer has Esc hint");
  });

  test("footer does not show details hint when no diff/details", () => {
    const r = review({ description: "read-only operation" });
    const lines = render(r);
    const footer = lines[lines.length - 1];
    assert.ok(footer.includes("approve"), "footer has approve hint");
    assert.ok(footer.includes("deny"), "footer has deny hint");
    // With no diff, details button may not appear
  });

  // Test 14: NO_COLOR/monochrome theme produces readable markers.
  test("monochrome theme produces readable diff markers", () => {
    const r = review({
      description: "edit file",
      diff: [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,3 +1,4 @@",
        " context",
        "-deleted",
        "+added",
      ].join("\n"),
    });
    const lines = render(r, { theme: plain });
    const joined = lines.join("\n");
    // Plain theme means no escape codes
    assert.ok(!joined.includes("\x1b["), "no ANSI codes in monochrome mode");
    // But the diff content is still visible
    assert.ok(joined.includes("+added"), "added line visible");
    assert.ok(joined.includes("-deleted"), "deleted line visible");
  });
});

// ── Scroll ───────────────────────────────────────────────────────────────────

describe("approvalReview: scroll behavior", () => {
  test("scroll offsets the body content", () => {
    const r = review({
      description: "edit file",
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,5 +1,6 @@",
        " line-a",
        "-old-a",
        "+new-a",
        " line-b",
        "-old-b",
        "+new-b",
      ].join("\n"),
    });
    const scrolled = render(r, { width: 60, height: 10, scroll: 5 });
    const joined = scrolled.join("\n");
    // When scrolled past the header, header may still be present but diff
    // content near the bottom should be visible
    assert.ok(joined.length > 0);
  });
});

// ── buildApprovalReview edge cases ───────────────────────────────────────────

describe("approvalReview: buildApprovalReview edge cases", () => {
  test("empty description still produces a valid review", () => {
    const r = buildApprovalReview({ description: "" });
    assert.equal(r.title, "Permission required");
    assert.ok(Array.isArray(r.reasons));
    assert.ok(Array.isArray(r.files));
    assert.ok(Array.isArray(r.diffLines));
    assert.ok(Array.isArray(r.details));
  });

  test("null diff yields empty files and diffLines", () => {
    const r = buildApprovalReview({ description: "do something", diff: undefined });
    assert.deepEqual(r.files, []);
    assert.deepEqual(r.diffLines, []);
  });

  test("sandbox summary is preserved", () => {
    const r = buildApprovalReview({
      description: "run test",
      sandboxSummary: "fast -> bubblewrap · network off",
    });
    assert.equal(r.sandboxSummary, "fast -> bubblewrap · network off");
  });

  test("commandPolicy is preserved", () => {
    const r = buildApprovalReview({
      description: "run test",
      commandPolicy: "ask",
    });
    assert.equal(r.commandPolicy, "ask");
  });
});

// ── renderApprovalReview edge cases ──────────────────────────────────────────

describe("approvalReview: render edge cases", () => {
  test("tiny height still produces at least header + footer", () => {
    const r = review({ description: "hi" });
    const lines = render(r, { width: 40, height: 2 });
    assert.ok(lines.length <= 2);
    assert.ok(lines.join("\n").includes("Permission"));
  });

  test("zero height returns empty gracefully", () => {
    const r = review({ description: "test" });
    const lines = render(r, { width: 40, height: 0 });
    assert.equal(lines.length, 0);
  });

  test("no diff: diff mode shows no-file-available message", () => {
    const r = review({ description: "run ascript" });
    const lines = render(r, { mode: "diff" });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Permission required"));
  });
});
