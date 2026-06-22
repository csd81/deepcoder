/**
 * Phase 10C — provider-aware cost estimation from normalized token usage.
 *
 * Static rate table keyed by provider + model pattern. Config-supplied pricing
 * overrides defaults (match by provider + modelPattern, substring/glob).
 * Unknown model/provider → { pricingKnown:false, totalUsd:0 } and NEVER throws.
 * Never fetches from the web.
 */

import type { TokenUsage } from "./types.js";

export interface ModelPricing {
  provider: string;
  modelPattern: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  effectiveDate: string;
  source?: string;
}

export interface CostEstimate {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  pricingKnown: boolean;
  rateLabel: string;
}

/**
 * Default rate table — conservative estimates, clearly labeled.
 * effectiveDate is the date the rate was last reviewed/updated.
 */
export const DEFAULT_PRICING: ModelPricing[] = [
  // DeepSeek — the one supported family.
  { provider: "deepseek", modelPattern: "deepseek-v4-flash", inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.10, effectiveDate: "2026-06-01", source: "deepseek.com/pricing" },
  { provider: "deepseek", modelPattern: "deepseek-v4-pro", inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, effectiveDate: "2026-06-01", source: "deepseek.com/pricing" },
  // Legacy aliases (still route to the same engine; kept for back-compat).
  { provider: "deepseek", modelPattern: "deepseek-chat", inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.10, effectiveDate: "2025-06-01", source: "deepseek.com/pricing" },
  { provider: "deepseek", modelPattern: "deepseek-reasoner", inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, effectiveDate: "2025-06-01", source: "deepseek.com/pricing" },
  // openai-compatible escape hatch defaults to a DeepSeek endpoint.
  { provider: "openai-compatible", modelPattern: "deepseek-v4-flash", inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.10, effectiveDate: "2026-06-01", source: "deepseek.com/pricing" },
  { provider: "openai-compatible", modelPattern: "deepseek-v4-pro", inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, effectiveDate: "2026-06-01", source: "deepseek.com/pricing" },
];

/**
 * Match a model name against a pattern. Supports:
 * - Exact match
 * - Glob-style wildcard: "*" matches everything, "gpt-4o*" matches "gpt-4o-mini"
 * - Substring match (pattern contained in model name)
 */
function modelMatches(model: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return model.startsWith(prefix);
  }
  if (pattern.startsWith("*")) {
    const suffix = pattern.slice(1);
    return model.endsWith(suffix);
  }
  // Substring match
  return model.includes(pattern) || pattern.includes(model);
}

/**
 * Find the best matching pricing entry for a given provider + model.
 * Config-supplied pricing (passed in) takes precedence over defaults.
 * Returns undefined when no match is found.
 */
export function findPricing(
  provider: string,
  model: string,
  overrides?: ModelPricing[],
): ModelPricing | undefined {
  const candidates: ModelPricing[] = [];

  // Check overrides first (config-supplied pricing beats defaults)
  if (overrides) {
    for (const p of overrides) {
      if (p.provider === provider && modelMatches(model, p.modelPattern)) {
        candidates.push(p);
      }
    }
  }

  // Then check defaults
  for (const p of DEFAULT_PRICING) {
    if (p.provider === provider && modelMatches(model, p.modelPattern)) {
      candidates.push(p);
    }
  }

  if (candidates.length === 0) return undefined;

  // Return the most specific match (longest modelPattern wins)
  candidates.sort((a, b) => b.modelPattern.length - a.modelPattern.length);
  return candidates[0];
}

/**
 * Estimate the cost of a token usage for a given provider + model.
 * NEVER throws. When pricing is unknown, returns { pricingKnown: false, totalUsd: 0 }.
 *
 * @param usage - The token usage to estimate cost for.
 * @param opts - Options including provider, model, and optional pricing overrides.
 */
export function estimateCost(
  usage: TokenUsage,
  opts: { provider: string; model: string; pricing?: ModelPricing[] },
): CostEstimate {
  try {
    const pricing = findPricing(opts.provider, opts.model, opts.pricing);

    if (!pricing) {
      return {
        inputUsd: 0,
        outputUsd: 0,
        totalUsd: 0,
        pricingKnown: false,
        rateLabel: "unknown",
      };
    }

    const inputUsd = (usage.promptTokens / 1_000_000) * pricing.inputPerMillionUsd;
    const outputUsd = (usage.completionTokens / 1_000_000) * pricing.outputPerMillionUsd;
    const totalUsd = inputUsd + outputUsd;

    return {
      inputUsd,
      outputUsd,
      totalUsd,
      pricingKnown: true,
      rateLabel: `${pricing.provider}/${pricing.modelPattern}`,
    };
  } catch {
    // NEVER throw — safety net for any unexpected error
    return {
      inputUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
      pricingKnown: false,
      rateLabel: "error",
    };
  }
}
