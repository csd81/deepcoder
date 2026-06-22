import type { ModelProvider } from "./types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { DEEPSEEK_DEFAULT_BASE_URL } from "./deepseek.js";
import { FauxProvider } from "./fauxProvider.js";
import type { Config } from "../config/config.js";

/**
 * Build a provider from config. deepcoder is DeepSeek-only: DeepSeek rides the
 * OpenAI-compatible engine directly, and `openai-compatible` is a generic escape
 * hatch (same engine) for pointing at a local/proxy/self-hosted DeepSeek endpoint
 * via DEEPCODER_BASE_URL. Both map onto the same `ModelProvider` boundary, so
 * nothing downstream is provider-aware.
 */
export function createProvider(config: Config): ModelProvider {
  switch (config.provider) {
    case "deepseek":
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || DEEPSEEK_DEFAULT_BASE_URL,
        label: "DeepSeek",
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      });

    case "openai-compatible":
      if (!config.baseUrl) {
        throw new Error(
          'provider "openai-compatible" requires a base URL (set DEEPCODER_BASE_URL).',
        );
      }
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        label: "OpenAI-compatible",
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      });

    // Test/smoke harness only: a canned no-op provider so the smoke suite can
    // drive the real CLI without keys or network. Not a user-facing provider.
    case "faux":
      return new FauxProvider();

    default:
      throw new Error(`Unknown provider "${config.provider}". Use deepseek | openai-compatible.`);
  }
}
