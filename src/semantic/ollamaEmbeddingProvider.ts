import { EmbeddingProvider } from './types.js';

export interface OllamaEmbeddingOptions {
  baseUrl: string;      // e.g. http://localhost:11434
  model: string;        // e.g. nomic-embed-text
  dimensions?: number | null;
  // Test seam: inject a fake fetch. Defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private dims: number | null;
  private fetchImpl: typeof fetch;

  constructor(options: OllamaEmbeddingOptions) {
    if (!options.baseUrl) {
      throw new Error('OllamaEmbeddingProvider: baseUrl is required');
    }
    if (!options.model) {
      throw new Error('OllamaEmbeddingProvider: model is required');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, ''); // strip trailing slash if any
    this.model = options.model;
    this.dims = options.dimensions ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }

    const url = `${this.baseUrl}/api/embed`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
      });
    } catch (err: any) {
      throw new Error(`Ollama embedding request failed: ${err.message || err}`);
    }

    if (!response.ok) {
      throw new Error(`Ollama embedding failed with status ${response.status}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      throw new Error('Ollama embedding failed: response is not valid JSON');
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Ollama embedding failed: response body is not an object');
    }

    if (!Array.isArray(data.embeddings)) {
      throw new Error('Ollama embedding failed: response does not contain an embeddings array');
    }

    for (let i = 0; i < data.embeddings.length; i++) {
      const emb = data.embeddings[i];
      if (!Array.isArray(emb)) {
        throw new Error(`Ollama embedding failed: embedding at index ${i} is not an array`);
      }
      for (let j = 0; j < emb.length; j++) {
        if (typeof emb[j] !== 'number' || Number.isNaN(emb[j])) {
          throw new Error(`Ollama embedding failed: embedding at index ${i} contains non-number values`);
        }
      }
    }

    return data.embeddings;
  }

  dimensions(): number | null {
    return this.dims;
  }

  label(): string {
    return `ollama/${this.model}`;
  }
}
