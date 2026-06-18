import { OpenAICompatibleProvider } from "./openaiCompatible.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek preset of the generic OpenAI-compatible provider. Kept as a named
 * class for backwards compatibility with existing imports.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string }) {
    super({ apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL, label: "DeepSeek" });
  }
}

// Re-export the shared error type so existing import paths keep working.
export { ProviderError } from "./openaiCompatible.js";
