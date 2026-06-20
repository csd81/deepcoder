import { EmbeddingProvider } from './types.js';
import { OllamaEmbeddingProvider } from './ollamaEmbeddingProvider.js';

export function createEmbeddingProvider(cfg: {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  dimensions?: number | null;
}): EmbeddingProvider | null {
  if (!cfg.enabled) {
    return null;
  }

  const providerLower = (cfg.provider || '').toLowerCase();
  if (providerLower === 'ollama' || providerLower === 'local') {
    return new OllamaEmbeddingProvider({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dimensions: cfg.dimensions,
    });
  }

  return null;
}
