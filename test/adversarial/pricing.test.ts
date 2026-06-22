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

test("[pricing-cache-discount] cache hits cost less than fresh prompt tokens on deepseek-v4-flash", () => {
  // flash: input 0.27/M, cached 0.027/M, output 1.10/M.
  const out = 200_000;
  const cached: TokenUsage = { promptTokens: 1_000_000, completionTokens: out, totalTokens: 1_000_000 + out, cachedPromptTokens: 900_000 };
  const fresh: TokenUsage = { promptTokens: 1_000_000, completionTokens: out, totalTokens: 1_000_000 + out, cachedPromptTokens: 0 };

  const cachedEst = estimateCost(cached, { provider: "deepseek", model: "deepseek-v4-flash" });
  const freshEst = estimateCost(fresh, { provider: "deepseek", model: "deepseek-v4-flash" });

  assert.equal(cachedEst.pricingKnown, true);
  assert.ok(cachedEst.totalUsd < freshEst.totalUsd, "discounted total is cheaper");

  // Exact: fresh 100k @0.27/M + cached 900k @0.027/M + output 200k @1.10/M.
  const expectedInput = (100_000 / 1e6) * 0.27 + (900_000 / 1e6) * 0.027;
  const expectedOutput = (out / 1e6) * 1.10;
  assert.ok(Math.abs(cachedEst.inputUsd - expectedInput) < 1e-9, `inputUsd ${cachedEst.inputUsd} ~= ${expectedInput}`);
  assert.ok(Math.abs(cachedEst.outputUsd - expectedOutput) < 1e-9, `outputUsd ${cachedEst.outputUsd} ~= ${expectedOutput}`);
  assert.ok(Math.abs(cachedEst.totalUsd - (expectedInput + expectedOutput)) < 1e-9);
  // cachedInputUsd is the portion attributable to cache hits.
  assert.ok(Math.abs(cachedEst.cachedInputUsd - (900_000 / 1e6) * 0.027) < 1e-9);
});

test("[pricing-cache-noregress] cachedPromptTokens=0 reproduces the old full-rate total", () => {
  const out = 200_000;
  const fresh: TokenUsage = { promptTokens: 1_000_000, completionTokens: out, totalTokens: 1_000_000 + out, cachedPromptTokens: 0 };
  const est = estimateCost(fresh, { provider: "deepseek", model: "deepseek-v4-flash" });
  const expectedInput = (1_000_000 / 1e6) * 0.27;
  const expectedOutput = (out / 1e6) * 1.10;
  assert.ok(Math.abs(est.inputUsd - expectedInput) < 1e-9);
  assert.ok(Math.abs(est.totalUsd - (expectedInput + expectedOutput)) < 1e-9);
  assert.equal(est.cachedInputUsd, 0);
});

test("[pricing-cache-unknown-zero] unknown pricing reports cachedInputUsd 0", () => {
  const est = estimateCost(usage, { provider: "nope", model: "no-such-model" });
  assert.equal(est.cachedInputUsd, 0);
});
