/**
 * Adversarial coverage for the proactive model-selection scorer
 * (`src/models/complexityScore.ts`).
 *
 * Guarantees under attack:
 *   - PURE and NEVER throws / blocks, for ANY input.
 *   - `model` is ALWAYS exactly "flash" or "pro" (never undefined / other).
 *   - Default threshold is 3; higher score → "pro".
 *   - Cost-safety: benign / empty input must STAY "flash" (don't pay for Pro
 *     unless genuinely necessary).
 *
 * These tests try to BREAK those guarantees with hostile / degenerate input.
 * They must not modify the source — where a degenerate value produces a
 * surprising-but-safe result, we pin the *actual* observed safe behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreComplexity } from "../../src/models/complexityScore.js";

const VALID_MODELS = new Set(["flash", "pro"]);

/** Assert a verdict is structurally valid no matter the input. */
function assertValidVerdict(v: ReturnType<typeof scoreComplexity>): void {
  assert.ok(v && typeof v === "object", "verdict is an object");
  assert.ok(VALID_MODELS.has(v.model), `model must be flash|pro, got ${String(v.model)}`);
  assert.equal(typeof v.score, "number", "score is a number");
  assert.ok(Array.isArray(v.reasons), "reasons is an array");
}

test("empty prompt does not throw and stays flash (benign default)", () => {
  let v!: ReturnType<typeof scoreComplexity>;
  assert.doesNotThrow(() => {
    v = scoreComplexity({ prompt: "" });
  });
  assertValidVerdict(v);
  assert.equal(v.model, "flash", "empty input must not pay for Pro");
  assert.equal(v.score, 0);
});

test("whitespace-only prompt does not throw and stays flash", () => {
  let v!: ReturnType<typeof scoreComplexity>;
  assert.doesNotThrow(() => {
    v = scoreComplexity({ prompt: "   \t\n  \r\n   " });
  });
  assertValidVerdict(v);
  assert.equal(v.model, "flash");
});

test("undefined-ish fields do not throw (prompt coerced safely)", () => {
  // The contract types `prompt: string`, but adversaries pass junk. The source
  // guards with `typeof s.prompt === "string" ? ... : ""`, so non-string
  // prompts must coerce to "" rather than throwing on `.toLowerCase()`.
  const hostile: Array<Record<string, unknown>> = [
    {}, // no prompt at all
    { prompt: undefined },
    { prompt: null },
    { prompt: 12345 },
    { prompt: {} },
    { prompt: [], fileCount: undefined, hasCheck: undefined },
    { prompt: "ok", fileCount: undefined, hasCheck: undefined },
  ];
  for (const s of hostile) {
    let v!: ReturnType<typeof scoreComplexity>;
    assert.doesNotThrow(() => {
      // deliberately bypass the type to feed hostile shapes
      v = scoreComplexity(s as unknown as { prompt: string });
    }, `threw on hostile input ${JSON.stringify(s)}`);
    assertValidVerdict(v);
  }
});

test("HUGE prompt (1M chars) returns within reason and does not throw", () => {
  const huge = "x".repeat(1_000_000);
  let v!: ReturnType<typeof scoreComplexity>;
  const start = Date.now();
  assert.doesNotThrow(() => {
    v = scoreComplexity({ prompt: huge });
  });
  const elapsed = Date.now() - start;
  assertValidVerdict(v);
  // A pure substring scan over 1M chars should be well under a second; give
  // generous headroom so this never flakes on a loaded CI box.
  assert.ok(elapsed < 5_000, `scoring took too long: ${elapsed}ms`);
});

test("keyword-bombing (hard keyword repeated 1000x) yields one valid verdict", () => {
  const bomb = "security ".repeat(1000);
  let v!: ReturnType<typeof scoreComplexity>;
  assert.doesNotThrow(() => {
    v = scoreComplexity({ prompt: bomb });
  });
  assertValidVerdict(v);
  // Repetition must not multiply the signal: each distinct keyword counts once
  // (the source uses `filter(includes)`), so a single repeated keyword is the
  // same as one mention. It is fine if this is "pro" via prompt length, but it
  // must remain a SINGLE valid verdict, not an inflated/invalid one.
  assert.equal(typeof v.model, "string");
  assert.ok(VALID_MODELS.has(v.model));
});

test("every hard keyword at once stays a valid single verdict (model pro)", () => {
  const all =
    "security permission classifier sandbox escalate refactor migrate " +
    "concurrency race deadlock architecture cross-cutting audit";
  let v!: ReturnType<typeof scoreComplexity>;
  assert.doesNotThrow(() => {
    v = scoreComplexity({ prompt: all });
  });
  assertValidVerdict(v);
  assert.equal(v.model, "pro", "an obviously-hard prompt should select pro");
});

test("hostile fileCount values do not throw; model stays flash|pro", () => {
  // Document observed SAFE behavior per value (source guards with
  // `typeof fileCount === 'number' && fileCount > 0`, else fileCount = 1):
  //   - negative / 0  -> falls back to 1 -> no breadth bonus -> flash
  //   - NaN           -> NaN > 0 is false -> falls back to 1 -> flash
  //   - Infinity      -> Infinity > 0 is true -> breadth Infinity -> score
  //                      Infinity (>= threshold) -> pro (still VALID, never throws)
  const cases: Array<{ fileCount: number; expectModel: "flash" | "pro" }> = [
    { fileCount: -1, expectModel: "flash" },
    { fileCount: -1000, expectModel: "flash" },
    { fileCount: 0, expectModel: "flash" },
    { fileCount: NaN, expectModel: "flash" },
    { fileCount: Infinity, expectModel: "pro" },
    { fileCount: -Infinity, expectModel: "flash" },
  ];
  for (const c of cases) {
    let v!: ReturnType<typeof scoreComplexity>;
    assert.doesNotThrow(() => {
      v = scoreComplexity({ prompt: "do a thing", fileCount: c.fileCount });
    }, `threw on fileCount=${c.fileCount}`);
    assertValidVerdict(v);
    assert.equal(
      v.model,
      c.expectModel,
      `fileCount=${c.fileCount} expected ${c.expectModel}, got ${v.model}`,
    );
  }
});

test("Infinity fileCount produces an Infinite score but a still-valid model", () => {
  // Pin the surprising-but-safe behavior explicitly: the score is non-finite,
  // yet the verdict remains structurally valid and never throws. This is the
  // kind of edge a future refactor might accidentally break.
  const v = scoreComplexity({ prompt: "narrow", fileCount: Infinity });
  assertValidVerdict(v);
  assert.equal(v.score, Infinity);
  assert.equal(v.model, "pro");
});

test("hostile hasCheck values do not throw; model stays flash|pro", () => {
  const cases: unknown[] = [true, false, 1, 0, "yes", "", null, undefined, {}, []];
  for (const hasCheck of cases) {
    let v!: ReturnType<typeof scoreComplexity>;
    assert.doesNotThrow(() => {
      v = scoreComplexity({ prompt: "ok", hasCheck } as unknown as {
        prompt: string;
      });
    }, `threw on hasCheck=${String(hasCheck)}`);
    assertValidVerdict(v);
  }
});

test("hostile threshold values do not throw; model stays flash|pro", () => {
  const thresholds = [NaN, Infinity, -Infinity, 0, -1, 1e9];
  for (const threshold of thresholds) {
    let v!: ReturnType<typeof scoreComplexity>;
    assert.doesNotThrow(() => {
      v = scoreComplexity({ prompt: "security refactor" }, { threshold });
    }, `threw on threshold=${threshold}`);
    assertValidVerdict(v);
  }
});

test("determinism: identical input yields a deeply-equal verdict", () => {
  const input = { prompt: "refactor the permission classifier", fileCount: 4, hasCheck: true };
  const a = scoreComplexity(input);
  const b = scoreComplexity(input);
  assert.deepEqual(a, b);

  // Also stable for hostile / degenerate input.
  const c = scoreComplexity({ prompt: "x".repeat(2000), fileCount: NaN });
  const d = scoreComplexity({ prompt: "x".repeat(2000), fileCount: NaN });
  assert.deepEqual(c, d);
});

test("monotonic-ish: a clearly-hard input scores >= a clearly-trivial input", () => {
  const trivial = scoreComplexity({ prompt: "rename a variable" });
  const hard = scoreComplexity({
    prompt:
      "refactor the security permission classifier sandbox escalation to fix a " +
      "concurrency race / deadlock across the whole architecture",
    fileCount: 12,
    hasCheck: true,
  });
  assertValidVerdict(trivial);
  assertValidVerdict(hard);
  assert.ok(hard.score >= trivial.score, `hard ${hard.score} < trivial ${trivial.score}`);
  assert.equal(trivial.model, "flash", "trivial task must not pay for Pro");
  assert.equal(hard.model, "pro", "clearly-hard task should select Pro");
});

test("default threshold is 3: score 2 stays flash, score 3 flips to pro", () => {
  // One hard keyword = +2 (below threshold) -> flash.
  const two = scoreComplexity({ prompt: "a small security fix" });
  assert.equal(two.score, 2);
  assert.equal(two.model, "flash");

  // One keyword (+2) plus a configured check (+1) = 3 (== threshold) -> pro.
  const three = scoreComplexity({ prompt: "a small security fix", hasCheck: true });
  assert.equal(three.score, 3);
  assert.equal(three.model, "pro");
});
