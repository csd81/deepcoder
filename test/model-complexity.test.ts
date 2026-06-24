import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreComplexity } from "../src/models/complexityScore.js";

test("trivial task → flash with a low (zero) score", () => {
  const v = scoreComplexity({ prompt: "add an isBlank helper" });
  assert.equal(v.model, "flash");
  assert.equal(v.score, 0);
  assert.ok(Array.isArray(v.reasons));
  assert.ok(v.reasons.length > 0);
});

test("security / cross-cutting task → pro and reasons name the keywords", () => {
  const v = scoreComplexity({
    prompt: "fix the permission classifier bypass across the agent loop",
  });
  // "permission" (+2) and "classifier" (+2) → 2 hits * 2 = 4.
  assert.equal(v.score, 4);
  assert.equal(v.model, "pro");
  const joined = v.reasons.join(" | ");
  assert.ok(joined.includes("permission"), `reasons mention permission: ${joined}`);
  assert.ok(joined.includes("classifier"), `reasons mention classifier: ${joined}`);
});

test("threshold boundary: score exactly at default threshold (3) → pro", () => {
  // No keywords; fileCount 4 → breadth 3 → score 3 == default threshold.
  const v = scoreComplexity({ prompt: "tidy up code", fileCount: 4 });
  assert.equal(v.score, 3);
  assert.equal(v.model, "pro");
});

test("threshold boundary: score just below default threshold (2) → flash", () => {
  // No keywords; fileCount 3 → breadth 2 → score 2 < default threshold 3.
  const v = scoreComplexity({ prompt: "tidy up code", fileCount: 3 });
  assert.equal(v.score, 2);
  assert.equal(v.model, "flash");
});

test("custom opts.threshold flips the decision for the same input", () => {
  const signals = { prompt: "tidy up code", fileCount: 4 }; // score 3

  const lenient = scoreComplexity(signals, { threshold: 5 });
  assert.equal(lenient.score, 3);
  assert.equal(lenient.model, "flash");

  const strict = scoreComplexity(signals, { threshold: 3 });
  assert.equal(strict.score, 3);
  assert.equal(strict.model, "pro");

  // And a threshold below the score keeps it pro.
  const veryStrict = scoreComplexity(signals, { threshold: 1 });
  assert.equal(veryStrict.model, "pro");
});

test("scope breadth alone (high fileCount, no keywords) can push to pro", () => {
  // No keywords, short prompt, no check; fileCount 8 → breadth 7 → score 7.
  const v = scoreComplexity({ prompt: "rename things", fileCount: 8 });
  assert.equal(v.score, 7);
  assert.equal(v.model, "pro");
  assert.ok(v.reasons.some((r) => r.includes("scope spans 8")), v.reasons.join(" | "));
});

test("hasCheck adds +1", () => {
  const without = scoreComplexity({ prompt: "do a thing" });
  assert.equal(without.score, 0);
  const withCheck = scoreComplexity({ prompt: "do a thing", hasCheck: true });
  assert.equal(withCheck.score, 1);
  assert.ok(
    withCheck.reasons.some((r) => r.toLowerCase().includes("check")),
    withCheck.reasons.join(" | "),
  );
});

test("long prompt (>=400 chars) adds +1; very long (>=1200) adds +2", () => {
  const long = "a".repeat(400);
  const longV = scoreComplexity({ prompt: long });
  assert.equal(longV.score, 1);
  assert.equal(longV.model, "flash");

  const veryLong = "a".repeat(1200);
  const veryLongV = scoreComplexity({ prompt: veryLong });
  assert.equal(veryLongV.score, 2);
  assert.equal(veryLongV.model, "flash");

  // Just under the long boundary → no length contribution.
  const shortish = "a".repeat(399);
  assert.equal(scoreComplexity({ prompt: shortish }).score, 0);
});

test("keyword stems match inflections (escalat, migrat, concurren)", () => {
  for (const prompt of [
    "handle privilege escalation",
    "write the migration",
    "fix the concurrency bug",
  ]) {
    const v = scoreComplexity({ prompt });
    assert.equal(v.score, 2, `one keyword hit for: ${prompt}`);
    assert.equal(v.model, "flash"); // single +2 hit is below default threshold 3
  }
});

test("signals combine additively (keywords + breadth + length + check)", () => {
  const prompt = "security audit ".repeat(30); // contains "security" and "audit"
  assert.ok(prompt.length >= 400 && prompt.length < 1200);
  const v = scoreComplexity({ prompt, fileCount: 3, hasCheck: true });
  // keywords: security (+2) + audit (+2) = 4; breadth (3-1) = 2; long prompt +1; check +1 = 8.
  assert.equal(v.score, 8);
  assert.equal(v.model, "pro");
});

test("reasons is always a non-empty array, even for the trivial case", () => {
  const v = scoreComplexity({ prompt: "" });
  assert.ok(Array.isArray(v.reasons));
  assert.ok(v.reasons.length > 0);
  // The final reason always records the score/threshold decision.
  assert.ok(v.reasons[v.reasons.length - 1].includes("threshold"), v.reasons.join(" | "));
});
