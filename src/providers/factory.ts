import type { ModelProvider } from "./types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { DEEPSEEK_DEFAULT_BASE_URL } from "./deepseek.js";
import type { Config } from "../config/config.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const QWEN_DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

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
        temperature: config.temperature,
      });

    case "ollama":
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey || "ollama", // Ollama ignores the key
        baseUrl: config.baseUrl || OLLAMA_DEFAULT_BASE_URL,
        label: "Ollama",
        temperature: config.temperature,
      });

    case "qwen":
      // Alibaba Qwen via the DashScope OpenAI-compatible endpoint.
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || QWEN_DEFAULT_BASE_URL,
        label: "Qwen",
        temperature: config.temperature,
      });

    case "gemini":
      // Google Gemini via its OpenAI-compatibility endpoint.
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || GEMINI_DEFAULT_BASE_URL,
        label: "Gemini",
        temperature: config.temperature,
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
      });

    case "anthropic":
      // Native Messages API adapter (not OpenAI-compatible). baseUrl optional.
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
        label: "Anthropic",
      });

    default:
      throw new Error(`Unknown provider "${config.provider}". Use deepseek | openai-compatible | ollama | qwen | gemini | anthropic.`);
  }
}
