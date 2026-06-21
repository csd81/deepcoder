/**
 * Curated OpenRouter free-model list.
 *
 * Rule (user, 2026-06-22): on OpenRouter only ever use `:free` models, never a
 * paid model — not even for a quick smoke test. `openrouter/auto` is therefore
 * unsafe as a default because it can route an invocation to a PAID model.
 *
 * The lists below come from a live probe of every `:free` model OpenRouter
 * advertised on 2026-06-22 (`GET /api/v1/models`, filtered to `:free`). Each
 * model was sent a one-word completion request:
 *   - OK        → returned a real completion (kept, in preference order)
 *   - SATURATED → reachable but 429 rate-limited (excluded; would "overuse" it)
 *   - 404       → delisted by OpenRouter (excluded)
 *
 * Re-probe periodically: free models churn (names get delisted, capacity moves).
 */

/** Working free models, preference-ordered (reliable + capable first). */
export const OPENROUTER_FREE_MODELS: readonly string[] = [
  "openai/gpt-oss-20b:free", // reliable + fast; returned PONG first try every run
  "openai/gpt-oss-120b:free", // most capable of the working set
  "nex-agi/nex-n2-pro:free",
  "cohere/north-mini-code:free", // code-oriented
  "poolside/laguna-m.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "poolside/laguna-xs.2:free",
  "liquid/lfm-2.5-1.2b-thinking:free",
  "nvidia/nemotron-nano-12b-v2-vl:free", // vision-language; lower for plain coding
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

/**
 * Free models that were live but rate-limited (429) at probe time. Documented
 * so they are explicitly excluded from the default rotation — using one as the
 * default would just "overuse" a saturated endpoint and fail. A caller may still
 * pin one via DEEPCODER_MODEL if they want to retry it later.
 */
export const OPENROUTER_SATURATED_MODELS: readonly string[] = [
  "google/gemma-4-26b-a4b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-coder:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
];

/** Default free model for the OpenRouter provider when none is pinned. */
export const OPENROUTER_DEFAULT_FREE_MODEL = OPENROUTER_FREE_MODELS[0];

/** True iff `model` is an OpenRouter free model (the `:free` suffix). */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}
