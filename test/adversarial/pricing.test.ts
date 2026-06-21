/**
 * Phase 10C (slice 1) — cost estimator. SEED (red-first): pins the safety
 * contract (an UNKNOWN model never throws and reports pricingKnown:false) so a
 * delegated worker MUST implement the pure estimator (no green-check no-op), then
 * EXTENDS with the rest from plans/phase10c-statusline-cost-telemetry-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost } from "../../src/providers/pricing.js";
import type { TokenUsage } from "../../src/providers/types.js";

const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };

test("[pricing-unknown-safe] an unknown model returns pricingKnown:false and never throws", () => {
  const est = estimateCost(usage, { provider: "nope", model: "no-such-model" });
  assert.equal(est.pricingKnown, false);
  assert.equal(est.totalUsd, 0);
});
