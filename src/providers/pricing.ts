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
  // DeepSeek
  { provider: "deepseek", modelPattern: "deepseek-chat", inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.10, effectiveDate: "2025-06-01", source: "deepseek.com/pricing" },
  { provider: "deepseek", modelPattern: "deepseek-reasoner", inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, effectiveDate: "2025-06-01", source: "deepseek.com/pricing" },
  // OpenAI GPT-4o family
  { provider: "openai-compatible", modelPattern: "gpt-4o", inputPerMillionUsd: 2.50, outputPerMillionUsd: 10.00, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  { provider: "openai-compatible", modelPattern: "gpt-4o-mini", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.60, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  { provider: "openai-compatible", modelPattern: "gpt-5", inputPerMillionUsd: 5.00, outputPerMillionUsd: 20.00, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  // OpenAI Responses
  { provider: "openai-responses", modelPattern: "gpt-4o", inputPerMillionUsd: 2.50, outputPerMillionUsd: 10.00, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  { provider: "openai-responses", modelPattern: "gpt-4o-mini", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.60, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  { provider: "openai-responses", modelPattern: "gpt-5", inputPerMillionUsd: 5.00, outputPerMillionUsd: 20.00, effectiveDate: "2025-06-01", source: "openai.com/pricing" },
  // Gemini
  { provider: "gemini", modelPattern: "gemini-3.1-pro-preview", inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00, effectiveDate: "2025-06-01", source: "ai.google.dev/pricing" },
  { provider: "gemini", modelPattern: "gemini-3", inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00, effectiveDate: "2025-06-01", source: "ai.google.dev/pricing" },
  // Anthropic
  { provider: "anthropic", modelPattern: "claude-3-5-sonnet", inputPerMillionUsd: 3.00, outputPerMillionUsd: 15.00, effectiveDate: "2025-06-01", source: "anthropic.com/pricing" },
  { provider: "anthropic", modelPattern: "claude-3-5-haiku", inputPerMillionUsd: 0.80, outputPerMillionUsd: 4.00, effectiveDate: "2025-06-01", source: "anthropic.com/pricing" },
  { provider: "anthropic", modelPattern: "claude-3-opus", inputPerMillionUsd: 15.00, outputPerMillionUsd: 75.00, effectiveDate: "2025-06-01", source: "anthropic.com/pricing" },
  // Ollama (local — free, but show a nominal rate so cost is "known")
  { provider: "ollama", modelPattern: "*", inputPerMillionUsd: 0, outputPerMillionUsd: 0, effectiveDate: "2025-06-01", source: "local (free)" },
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
