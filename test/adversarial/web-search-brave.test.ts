/**
 * Phase 10E.6 — Brave Search API provider adversarial tests.
 *
 * Tests the `createBraveSearchProvider` factory with a FAKE fetch (no real network).
 * Coverage:
 *   [10E6-brave-map]    maps Brave JSON results into WebSearchResult
 *   [10E6-brave-header] key is sent as a header, never in URL/query
 *   [10E6-brave-nokey]  empty/missing key is ok at provider level (factory handles refusal)
 *   [10E6-brave-non2xx] non-2xx response returns bounded empty result (no throw)
 *   [10E6-brave-timeout] timeout aborts and returns bounded empty result
 *   [10E6-brave-empty]  empty Brave response yields empty results
 *   [10E6-brave-source] result source is set to "brave"
 *   [10E6-brave-freshness] recencyDays maps to freshness param correctly
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBraveSearchProvider } from "../../src/web/providers/brave.js";

// ---------------------------------------------------------------------------
// Helper: build a fake fetch that captures request info and returns canned JSON
// ---------------------------------------------------------------------------

interface FakeFetchCall {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function fakeFetch(
  responseBody: unknown,
  status = 200,
  recordCall?: (call: FakeFetchCall) => void,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const call: FakeFetchCall = {
      url: typeof url === "string" ? url : url.toString(),
      init: (init ?? {}) as RequestInit & { headers: Record<string, string> },
    };
    if (recordCall) recordCall(call);
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// [10E6-brave-map] maps Brave JSON results into WebSearchResult
// ---------------------------------------------------------------------------

test("[10E6-brave-map] maps title, url, description into WebSearchResult fields", async () => {
  const braveResponse = {
    web: {
      results: [
        {
          title: "TypeScript 5.5 Release",
          url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-5/",
          description: "Learn about the new features in TypeScript 5.5 including inferred type predicates.",
          age: "2024-07-01T00:00:00Z",
        },
      ],
    },
  };

  const provider = createBraveSearchProvider({
    apiKey: "test-key-123",
    fetchImpl: fakeFetch(braveResponse),
  });

  const results = await provider.search("typescript 5.5", { maxResults: 5 });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "TypeScript 5.5 Release");
  assert.equal(results[0].url, "https://devblogs.microsoft.com/typescript/announcing-typescript-5-5/");
  assert.equal(results[0].snippet, "Learn about the new features in TypeScript 5.5 including inferred type predicates.");
  assert.equal(results[0].source, "brave");
});

test("[10E6-brave-map] publishedAt maps from page_age preferentially", async () => {
  const braveResponse = {
    web: {
      results: [
        {
          title: "Node.js v20",
          url: "https://nodejs.org/en/blog/release/v20.0.0",
          description: "Node.js 20 release",
          age: "2024-01-10T00:00:00Z",
          page_age: "2024-06-15T00:00:00Z",
        },
      ],
    },
  };

  const provider = createBraveSearchProvider({
    apiKey: "test-key",
    fetchImpl: fakeFetch(braveResponse),
  });

  const results = await provider.search("nodejs", { maxResults: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].publishedAt, "2024-06-15T00:00:00Z");
});

test("[10E6-brave-map] publishedAt uses age when page_age is absent", async () => {
  const braveResponse = {
    web: {
      results: [
        {
          title: "Rust 1.75",
          url: "https://blog.rust-lang.org/2024/01/15/Rust-1.75.0.html",
          description: "Announcing Rust 1.75.0",
          age: "2024-01-15T00:00:00Z",
        },
      ],
    },
  };

  const provider = createBraveSearchProvider({
    apiKey: "test-key",
    fetchImpl: fakeFetch(braveResponse),
  });

  const results = await provider.search("rust", { maxResults: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].publishedAt, "2024-01-15T00:00:00Z");
});

// ---------------------------------------------------------------------------
// [10E6-brave-header] key is sent as a header, never in URL
// ---------------------------------------------------------------------------

test("[10E6-brave-header] api key is sent in X-Subscription-Token header, not in URL", async () => {
  let capturedCall: FakeFetchCall | undefined;
  const braveResponse = { web: { results: [] } };

  const provider = createBraveSearchProvider({
    apiKey: "my-secret-api-key-789",
    fetchImpl: fakeFetch(braveResponse, 200, (c) => { capturedCall = c; }),
  });

  await provider.search("test query", { maxResults: 5 });

  assert.ok(capturedCall, "fetch should have been called");
  // Key must be in header
  assert.equal(
    capturedCall!.init.headers["X-Subscription-Token"],
    "my-secret-api-key-789",
    "key must be in X-Subscription-Token header",
  );
  // Key must NOT appear in the URL
  assert.doesNotMatch(capturedCall!.url, /my-secret-api-key/, "key must NOT appear in URL");
  assert.doesNotMatch(capturedCall!.url, /api_key/i, "no api_key query param");
  assert.doesNotMatch(capturedCall!.url, /subscription/i, "no subscription query param");
});

// ---------------------------------------------------------------------------
// [10E6-brave-nokey] empty/missing key — provider-level behaviour
// ---------------------------------------------------------------------------

test("[10E6-brave-nokey] empty key string still creates a provider that makes a request (factory is where missing key is refused)", async () => {
  let capturedCall: FakeFetchCall | undefined;
  const braveResponse = { web: { results: [] } };

  const provider = createBraveSearchProvider({
    apiKey: "",
    fetchImpl: fakeFetch(braveResponse, 200, (c) => { capturedCall = c; }),
  });

  // Provider itself doesn't validate the key (factory does) — it sends it as-is
  // The key being empty should not throw at provider level
  const results = await provider.search("test", { maxResults: 5 });
  assert.equal(results.length, 0, "empty results from empty response");
  assert.ok(capturedCall, "fetch was still called");
  assert.equal(capturedCall!.init.headers["X-Subscription-Token"], "");
});

// ---------------------------------------------------------------------------
// [10E6-brave-non2xx] non-2xx response returns bounded empty result
// ---------------------------------------------------------------------------

test("[10E6-brave-non2xx] 401 response returns empty results without throwing", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "bad-key",
    fetchImpl: fakeFetch({ error: "unauthorized" }, 401),
  });

  const results = await provider.search("test", { maxResults: 5 });
  assert.ok(Array.isArray(results), "must return an array");
  assert.equal(results.length, 0, "401 returns empty results, not a throw");
});

test("[10E6-brave-non2xx] 429 rate-limit response returns empty results", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "rate-limited",
    fetchImpl: fakeFetch({ error: "rate limit" }, 429),
  });

  const results = await provider.search("test", { maxResults: 5 });
  assert.equal(results.length, 0, "429 returns empty results");
});

test("[10E6-brave-non2xx] 500 server error returns empty results", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "server-error",
    fetchImpl: fakeFetch({ error: "internal" }, 500),
  });

  const results = await provider.search("test", { maxResults: 5 });
  assert.equal(results.length, 0, "500 returns empty results");
});

// ---------------------------------------------------------------------------
// [10E6-brave-timeout] timeout aborts and returns bounded empty result
// ---------------------------------------------------------------------------

test("[10E6-brave-timeout] timeout aborts and returns bounded empty result", async () => {
  // Use a short 10ms timeout so the test finishes quickly
  const provider = createBraveSearchProvider({
    apiKey: "key",
    timeoutMs: 10,
    fetchImpl: ((_url, init) => {
      // A fetch that never resolves unless the timeout aborts it
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch,
  });

  const results = await provider.search("test", { maxResults: 5 });
  assert.ok(Array.isArray(results), "must return an array on timeout");
  assert.equal(results.length, 0, "timeout returns empty results");
});

// ---------------------------------------------------------------------------
// [10E6-brave-empty] empty Brave response yields empty results
// ---------------------------------------------------------------------------

test("[10E6-brave-empty] empty web.results array returns empty", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }),
  });

  const results = await provider.search("anything", { maxResults: 5 });
  assert.equal(results.length, 0);
});

test("[10E6-brave-empty] missing web field returns empty", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({}),
  });

  const results = await provider.search("anything", { maxResults: 5 });
  assert.equal(results.length, 0);
});

test("[10E6-brave-empty] null web field returns empty", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: null }),
  });

  const results = await provider.search("anything", { maxResults: 5 });
  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// [10E6-brave-source] result source is set to "brave"
// ---------------------------------------------------------------------------

test("[10E6-brave-source] each result has source set to 'brave'", async () => {
  const braveResponse = {
    web: {
      results: [
        { title: "A", url: "https://a.com", description: "desc a" },
        { title: "B", url: "https://b.com", description: "desc b" },
      ],
    },
  };

  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch(braveResponse),
  });

  const results = await provider.search("test", { maxResults: 5 });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.source, "brave", "source must be set to 'brave'");
  }
});

// ---------------------------------------------------------------------------
// [10E6-brave-freshness] recencyDays maps to freshness param correctly
// ---------------------------------------------------------------------------

test("[10E6-brave-freshness] recencyDays=1 sends freshness=pd", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5, recencyDays: 1 });
  assert.match(capturedUrl, /freshness=pd/, "1 day → pd (past day)");
});

test("[10E6-brave-freshness] recencyDays=7 sends freshness=pw", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5, recencyDays: 7 });
  assert.match(capturedUrl, /freshness=pw/, "7 days → pw (past week)");
});

test("[10E6-brave-freshness] recencyDays=30 sends freshness=pm", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5, recencyDays: 30 });
  assert.match(capturedUrl, /freshness=pm/, "30 days → pm (past month)");
});

test("[10E6-brave-freshness] recencyDays=365 sends freshness=py", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5, recencyDays: 365 });
  assert.match(capturedUrl, /freshness=py/, "365 days → py (past year)");
});

test("[10E6-brave-freshness] no recencyDays does not send freshness", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5 });
  assert.doesNotMatch(capturedUrl, /freshness=/, "no recencyDays → no freshness param");
});

test("[10E6-brave-freshness] recencyDays=0 does not send freshness", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5, recencyDays: 0 });
  assert.doesNotMatch(capturedUrl, /freshness=/, "recencyDays=0 → no freshness param");
});

// ---------------------------------------------------------------------------
// [10E6-brave-count] maxResults maps to count param
// ---------------------------------------------------------------------------

test("[10E6-brave-count] maxResults maps to count query param", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 3 });
  assert.match(capturedUrl, /count=3/, "maxResults=3 → count=3");
});

test("[10E6-brave-count] count is capped at 20", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 100 });
  assert.match(capturedUrl, /count=20/, "maxResults=100 → capped at count=20");
});

// ---------------------------------------------------------------------------
// [10E6-brave-name] provider name is "brave"
// ---------------------------------------------------------------------------

test("[10E6-brave-name] provider name is 'brave'", async () => {
  const provider = createBraveSearchProvider({
    apiKey: "key",
    fetchImpl: fakeFetch({ web: { results: [] } }),
  });
  assert.equal(provider.name, "brave");
});

// ---------------------------------------------------------------------------
// [10E6-brave-custom-url] custom baseUrl is respected
// ---------------------------------------------------------------------------

test("[10E6-brave-custom-url] custom baseUrl is used", async () => {
  let capturedUrl = "";
  const provider = createBraveSearchProvider({
    apiKey: "key",
    baseUrl: "https://custom-brave.example.com/search",
    fetchImpl: fakeFetch({ web: { results: [] } }, 200, (c) => { capturedUrl = c.url; }),
  });

  await provider.search("test", { maxResults: 5 });
  assert.ok(capturedUrl.startsWith("https://custom-brave.example.com/search"), "custom baseUrl is used");
});
