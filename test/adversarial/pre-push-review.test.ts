import { test } from "node:test";
import assert from "node:assert/strict";
import { prePushReview, formatFinding } from "../../src/cli/prePushReview.js";
import type { SubagentFinding } from "../../src/subagents/types.js";

// ── formatFinding ───────────────────────────────────────────────────────────

test("formatFinding includes severity, file:line, claim, and evidence", () => {
  const out = formatFinding({
    severity: "high",
    file: "src/bar.ts",
    line: 99,
    claim: "missing await",
    evidence: "async call not awaited",
  });
  assert.ok(out.includes("high"));
  assert.ok(out.includes("src/bar.ts"));
  assert.ok(out.includes("99"));
  assert.ok(out.includes("missing await"));
  assert.ok(out.includes("async call not awaited"));
});

test("formatFinding handles file-less findings", () => {
  const out = formatFinding({
    severity: "low",
    claim: "stray console.log",
    evidence: "found console.log in production path",
  });
  assert.ok(out.startsWith("[low]:"));
  assert.ok(out.includes("stray console.log"));
});

test("formatFinding handles line-less findings with file", () => {
  const out = formatFinding({
    severity: "critical",
    file: "pkg/mod.ts",
    claim: "unsafe eval",
    evidence: "eval with user input",
  });
  assert.ok(out.includes("pkg/mod.ts"));
  assert.ok(out.includes("critical"));
});

// ── prePushReview ───────────────────────────────────────────────────────────

test("empty diff returns LGTM", async () => {
  let called = false;
  const res = await prePushReview("", async (_diff) => {
    called = true;
    return [];
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.issues, []);
  assert.equal(called, true);
});

test("review returning no findings returns LGTM", async () => {
  const res = await prePushReview("+x", async () => []);
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.issues, []);
});

test("review returning findings sets ok=false and exitCode=1", async () => {
  const res = await prePushReview("@@ -1,3 +1,3 @@", async () => [
    { severity: "high", file: "src/x.ts", line: 1, claim: "inverted condition", evidence: "e" },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.equal(res.issues.length, 1);
  assert.ok(res.issues[0]!.includes("inverted condition"));
});

test("multiple findings all appear in issues", async () => {
  const res = await prePushReview("diff", async () => [
    { severity: "critical", file: "a.ts", line: 1, claim: "bug A", evidence: "e" },
    { severity: "high", file: "b.ts", line: 2, claim: "bug B", evidence: "e" },
    { severity: "medium", file: "c.ts", line: 3, claim: "bug C", evidence: "e" },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.equal(res.issues.length, 3);
  assert.ok(res.issues.some((s) => s.includes("bug A")));
  assert.ok(res.issues.some((s) => s.includes("bug B")));
  assert.ok(res.issues.some((s) => s.includes("bug C")));
});

test("review function that throws propagates the error", async () => {
  await assert.rejects(
    prePushReview("diff", async () => { throw new Error("model unreachable"); }),
    /model unreachable/,
  );
});
