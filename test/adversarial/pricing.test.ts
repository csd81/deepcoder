/**
 * Phase 10C (slice 1) — cost estimator. SEED (red-first): pins the safety
 * contract (an UNKNOWN model never throws and reports pricingKnown:false) so a
 * delegated worker MUST implement the pure estimator (no green-check no-op), then
 * EXTENDS with the rest from plans/ui/phase10c-statusline-cost-telemetry-plan.md.
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

import { findPricing } from "../../src/providers/pricing.js";

test("[pricing-known] a default-table model returns a known, positive cost", () => {
  const est = estimateCost(usage, { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(est.pricingKnown, true);
  assert.ok(est.totalUsd > 0);
  assert.equal(est.totalUsd, est.inputUsd + est.outputUsd);
});

test("[pricing-override] config pricing overrides the default rate", () => {
  const override = [{ provider: "deepseek", modelPattern: "deepseek-chat", inputPerMillionUsd: 999, outputPerMillionUsd: 999, effectiveDate: "2026-06-21" }];
  const def = estimateCost(usage, { provider: "deepseek", model: "deepseek-chat" });
  const ovr = estimateCost(usage, { provider: "deepseek", model: "deepseek-chat", pricing: override });
  assert.equal(ovr.pricingKnown, true);
  assert.ok(ovr.totalUsd > def.totalUsd, "override rate (999) costs more than the default");
  assert.equal(findPricing("deepseek", "deepseek-chat", override)?.inputPerMillionUsd, 999);
});
