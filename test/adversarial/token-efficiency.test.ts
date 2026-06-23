/**
 * Token-optimization plan, item 1 — token-efficiency report.
 *
 * The plan's thesis: on a prefix-cached DeepSeek agent, token TYPE dominates
 * token COUNT (output : fresh-input : cached-input bill 40 : 10 : 1). This
 * report surfaces cache-hit rate and which cost CLASS dominates so optimization
 * is data-driven rather than guesswork.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, tokenEfficiency } from "../../src/providers/pricing.js";
import type { TokenUsage } from "../../src/providers/types.js";

function eff(usage: TokenUsage) {
  const cost = estimateCost(usage, { provider: "deepseek", model: "deepseek-v4-flash" });
  return tokenEfficiency(usage, cost);
}

test("[token-eff-hit-rate] cache-hit rate = cached / prompt tokens", () => {
  const e = eff({ promptTokens: 1_000_000, completionTokens: 1000, totalTokens: 1_001_000, cachedPromptTokens: 900_000 });
  assert.equal(e.cacheHitRate, 0.9);
  assert.equal(e.freshPromptTokens, 100_000);
  assert.equal(e.cachedPromptTokens, 900_000);
});

test("[token-eff-no-divide-by-zero] zero prompt tokens yields a 0 hit rate, never NaN", () => {
  const e = eff({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 });
  assert.equal(e.cacheHitRate, 0);
  assert.ok(Number.isFinite(e.cacheHitRate));
});

test("[token-eff-output-dominates] a turn with heavy output is flagged output-dominant", () => {
  // flash: output 1.10/M is 40x the cached-input rate. Even a fully cached 1M
  // prompt is cheaper than 200k output tokens.
  const e = eff({ promptTokens: 1_000_000, completionTokens: 200_000, totalTokens: 1_200_000, cachedPromptTokens: 1_000_000 });
  assert.equal(e.dominantCostClass, "output");
  assert.ok(e.outputUsd > e.freshInputUsd);
  assert.ok(e.outputUsd > e.cachedInputUsd);
});

test("[token-eff-fresh-dominates] a cold cache with little output is fresh-input-dominant", () => {
  const e = eff({ promptTokens: 1_000_000, completionTokens: 1000, totalTokens: 1_001_000, cachedPromptTokens: 0 });
  assert.equal(e.dominantCostClass, "fresh-input");
  assert.equal(e.cachedInputUsd, 0);
});

test("[token-eff-cost-split] fresh + cached input USD reconcile with the estimate", () => {
  const usage: TokenUsage = { promptTokens: 1_000_000, completionTokens: 50_000, totalTokens: 1_050_000, cachedPromptTokens: 600_000 };
  const cost = estimateCost(usage, { provider: "deepseek", model: "deepseek-v4-flash" });
  const e = tokenEfficiency(usage, cost);
  assert.ok(Math.abs(e.freshInputUsd + e.cachedInputUsd - cost.inputUsd) < 1e-9);
  assert.equal(e.outputUsd, cost.outputUsd);
});
