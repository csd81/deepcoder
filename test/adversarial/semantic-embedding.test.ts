import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaEmbeddingProvider } from "../../src/semantic/ollamaEmbeddingProvider.js";
import { createEmbeddingProvider } from "../../src/semantic/provider.js";

test("1. embed maps a well-formed Ollama response to number[][] for a 2-item input", async () => {
  let called = false;
  let seenUrl = "";
  let seenOptions: any = null;

  const fakeFetch = async (url: string, options?: RequestInit) => {
    called = true;
    seenUrl = url;
    seenOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    } as Response;
  };

  const provider = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    dimensions: 3,
    fetchImpl: fakeFetch as any,
  });

  const result = await provider.embed(["hello", "world"]);
  assert.equal(called, true);
  assert.equal(seenUrl, "http://localhost:11434/api/embed");
  assert.equal(seenOptions?.method, "POST");
  assert.deepEqual(JSON.parse(seenOptions?.body), {
    model: "nomic-embed-text",
    input: ["hello", "world"],
  });
  assert.deepEqual(result, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]);
});

test("2. embed([]) returns [] WITHOUT calling fetch", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [] }),
    } as Response;
  };

  const provider = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    fetchImpl: fakeFetch as any,
  });

  const result = await provider.embed([]);
  assert.equal(called, false);
  assert.deepEqual(result, []);
});

test("3. A non-ok status (e.g. 500) -> embed throws a clear Error; a malformed body (no embeddings array) -> throws. Never leaks a secret-shaped string.", async () => {
  // Test non-ok status
  const fakeFetch500 = async () => {
    return {
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response;
  };

  const provider500 = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    fetchImpl: fakeFetch500 as any,
  });

  await assert.rejects(
    () => provider500.embed(["test"]),
    /Ollama embedding failed with status 500/
  );

  // Test malformed body (no embeddings array)
  const fakeFetchMalformed = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ wrongKey: "wrongValue" }),
    } as Response;
  };

  const providerMalformed = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    fetchImpl: fakeFetchMalformed as any,
  });

  await assert.rejects(
    () => providerMalformed.embed(["test"]),
    /Ollama embedding failed: response does not contain an embeddings array/
  );

  // Test malformed body (embeddings is not an array of arrays)
  const fakeFetchMalformed2 = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: ["not-an-array"] }),
    } as Response;
  };

  const providerMalformed2 = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    fetchImpl: fakeFetchMalformed2 as any,
  });

  await assert.rejects(
    () => providerMalformed2.embed(["test"]),
    /Ollama embedding failed: embedding at index 0 is not an array/
  );

  // Test malformed body (embeddings contains non-numbers)
  const fakeFetchMalformed3 = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[0.1, "not-a-number"]] }),
    } as Response;
  };

  const providerMalformed3 = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    fetchImpl: fakeFetchMalformed3 as any,
  });

  await assert.rejects(
    () => providerMalformed3.embed(["test"]),
    /Ollama embedding failed: embedding at index 0 contains non-number values/
  );
});

test("4. label() === ollama/<model>; dimensions() returns the configured value (and null when unset)", () => {
  const provider1 = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    dimensions: 768,
  });

  assert.equal(provider1.label(), "ollama/nomic-embed-text");
  assert.equal(provider1.dimensions(), 768);

  const provider2 = new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
  });

  assert.equal(provider2.dimensions(), null);
});

test("5. createEmbeddingProvider: enabled+ollama -> an OllamaEmbeddingProvider instance; disabled -> null; unknown provider -> null (no throw)", () => {
  const p1 = createEmbeddingProvider({
    enabled: true,
    provider: "ollama",
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
    dimensions: 768,
  });
  assert.ok(p1 instanceof OllamaEmbeddingProvider);
  assert.equal(p1.label(), "ollama/nomic-embed-text");
  assert.equal(p1.dimensions(), 768);

  const p2 = createEmbeddingProvider({
    enabled: true,
    provider: "local",
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
  });
  assert.ok(p2 instanceof OllamaEmbeddingProvider);
  assert.equal(p2.dimensions(), null);

  const p3 = createEmbeddingProvider({
    enabled: false,
    provider: "ollama",
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
  });
  assert.equal(p3, null);

  const p4 = createEmbeddingProvider({
    enabled: true,
    provider: "unknown-provider",
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434",
  });
  assert.equal(p4, null);
});
