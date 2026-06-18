import type { ModelProvider } from "./types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { DEEPSEEK_DEFAULT_BASE_URL } from "./deepseek.js";
import type { Config } from "../config/config.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * Build a provider from config. All providers map onto the same
 * `ModelProvider` boundary, so nothing downstream is provider-aware. DeepSeek
 * is the default; Ollama needs no key; OpenAI-compatible requires a base URL;
 * Anthropic is deferred (different wire shape).
 */
export function createProvider(config: Config): ModelProvider {
  switch (config.provider) {
    case "deepseek":
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || DEEPSEEK_DEFAULT_BASE_URL,
        label: "DeepSeek",
      });

    case "ollama":
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey || "ollama", // Ollama ignores the key
        baseUrl: config.baseUrl || OLLAMA_DEFAULT_BASE_URL,
        label: "Ollama",
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
      });

    case "anthropic":
      throw new Error(
        'provider "anthropic" is not supported yet. Use "openai-compatible" with an Anthropic-compatible gateway, or "deepseek".',
      );

    default:
      throw new Error(`Unknown provider "${config.provider}". Use deepseek | openai-compatible | ollama.`);
  }
}
