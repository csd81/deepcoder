import type { TokenUsage } from "./types.js";

export const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };

/**
 * Normalize a provider's raw usage object into TokenUsage. Handles the
 * chat-completions shape (`prompt_tokens`/`completion_tokens`/`total_tokens`)
 * and the Responses shape (`input_tokens`/`output_tokens`). Returns undefined
 * when no token counts are present. Never throws.
 */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const prompt = num("prompt_tokens", "input_tokens", "promptTokens");
  const completion = num("completion_tokens", "output_tokens", "completionTokens");
  const total = num("total_tokens", "totalTokens");
  // Cache hits: DeepSeek `prompt_cache_hit_tokens`, OpenAI `cached_tokens`,
  // Anthropic `cache_read_input_tokens`. `promptTokens` stays the total (hit+miss).
  const cached = num("prompt_cache_hit_tokens", "cached_tokens", "cache_read_input_tokens");
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const p = prompt ?? 0;
  const c = completion ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: total ?? p + c, cachedPromptTokens: cached ?? 0 };
}

/** Accumulate `add` into `acc` (mutating and returning it); ignores undefined. */
export function addUsage(acc: TokenUsage, add: TokenUsage | undefined): TokenUsage {
  if (!add) return acc;
  acc.promptTokens += add.promptTokens;
  acc.completionTokens += add.completionTokens;
  acc.totalTokens += add.totalTokens;
  acc.cachedPromptTokens = (acc.cachedPromptTokens ?? 0) + (add.cachedPromptTokens ?? 0);
  return acc;
}
