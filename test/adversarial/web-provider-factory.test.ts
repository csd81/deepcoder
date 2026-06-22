/**
 * Phase 10E.6 — Web search provider factory adversarial tests.
 *
 * Tests `createWebSearchProviderFromConfig` with explicit config/env parameters
 * (pure module — no real network, no env mutation).
 *
 * Coverage:
 *   [10E6-factory-disabled]   web disabled → noneProvider
 *   [10E6-factory-none]       searchProvider="none" → noneProvider
 *   [10E6-factory-brave]      searchProvider="brave" + API key → brave provider
 *   [10E6-factory-brave-nokey] searchProvider="brave" without key → noneProvider
 *   [10E6-factory-unknown]    unknown provider → noneProvider
 *   [10E6-factory-brave-key-spaces] key with surrounding whitespace is trimmed
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchProviderFromConfig } from "../../src/web/providerFactory.js";
import type { WebConfig } from "../../src/config/webConfig.js";

// ---------------------------------------------------------------------------
// Helper: default web config with just the toggles we need
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    enabled: false,
    searchProvider: "none",
    fetchEnabled: true,
    allowedDomains: [],
    blockedDomains: ["localhost", "127.0.0.1", "169.254.169.254"],
    maxResults: 5,
    maxFetchBytes: 200000,
    maxReturnedChars: 12000,
    timeoutMs: 15000,
    redirects: 3,
    quarantine: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// [10E6-factory-disabled] web disabled → noneProvider
// ---------------------------------------------------------------------------

test("[10E6-factory-disabled] web disabled with brave config returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: false, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "valid-key" },
  });

  assert.equal(provider.name, "none", "disabled web → noneProvider");
});

test("[10E6-factory-disabled] web disabled with no config still returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: false }),
    env: {},
  });

  assert.equal(provider.name, "none");
});

// ---------------------------------------------------------------------------
// [10E6-factory-none] searchProvider="none" → noneProvider
// ---------------------------------------------------------------------------

test("[10E6-factory-none] explicit none provider returns noneProvider even when enabled", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "none" }),
    env: {},
  });

  assert.equal(provider.name, "none", "explicit 'none' → noneProvider");
});

// ---------------------------------------------------------------------------
// [10E6-factory-brave] searchProvider="brave" + API key → brave provider
// ---------------------------------------------------------------------------

test("[10E6-factory-brave] enabled + brave + valid key returns brave provider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "valid-api-key-123" },
  });

  assert.equal(provider.name, "brave", "should return brave provider");
});

test("[10E6-factory-brave] enabled + brave + valid key can search (using fake fetch)", async () => {
  // Use a fake fetch to prove the brave provider is properly constructed
  const fetchImpl = (async (url: string) => {
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: "Test Result",
              url: "https://example.com/test",
              description: "A test result",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "key" },
    fetchImpl,
  });

  assert.equal(provider.name, "brave");
  const results = await provider.search("test", { maxResults: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Test Result");
  assert.equal(results[0].source, "brave");
});

// ---------------------------------------------------------------------------
// [10E6-factory-brave-nokey] searchProvider="brave" without key → noneProvider
// ---------------------------------------------------------------------------

test("[10E6-factory-brave-nokey] enabled + brave + missing key returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: {},
  });

  assert.equal(provider.name, "none", "brave without key → noneProvider");
});

test("[10E6-factory-brave-nokey] enabled + brave + empty string key returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "" },
  });

  assert.equal(provider.name, "none", "brave with empty key → noneProvider");
});

test("[10E6-factory-brave-nokey] enabled + brave + whitespace-only key returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "   " },
  });

  assert.equal(provider.name, "none", "brave with whitespace-only key → noneProvider");
});

// ---------------------------------------------------------------------------
// [10E6-factory-unknown] unknown provider → noneProvider
// ---------------------------------------------------------------------------

test("[10E6-factory-unknown] enabled + unknown provider returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "kagi" }),
    env: {},
  });

  assert.equal(provider.name, "none", "unknown provider → noneProvider");
});

test("[10E6-factory-unknown] enabled + unknown provider with key still returns noneProvider", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "tavily" }),
    env: { TAVILY_API_KEY: "key" },
  });

  assert.equal(provider.name, "none", "unsupported provider even with key → noneProvider");
});

// ---------------------------------------------------------------------------
// [10E6-factory-brave-key-spaces] key with surrounding whitespace is trimmed
// ---------------------------------------------------------------------------

test("[10E6-factory-brave-key-spaces] trimmed key is accepted", () => {
  const provider = createWebSearchProviderFromConfig({
    config: makeConfig({ enabled: true, searchProvider: "brave" }),
    env: { BRAVE_SEARCH_API_KEY: "  my-real-key  " },
  });

  assert.equal(provider.name, "brave", "trimmed key → brave provider");
});
