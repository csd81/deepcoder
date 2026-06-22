/**
 * Phase 10E.8 — Adversarial tests for pure /web slash command handlers.
 *
 * Covers:
 *   [10E8-status]   `/web status` shows disabled defaults and hint
 *   [10E8-status-on] `/web status` shows all fields when enabled
 *   [10E8-search-disabled] `/web search` refuses when web disabled
 *   [10E8-search-none] `/web search` refuses with provider `"none"`
 *   [10E8-search-ok] `/web search` with manual provider appends trace and prints bounded results
 *   [10E8-fetch-blocked] `/web fetch` blocked URL appends blocked trace and prints reason
 *   [10E8-fetch-ok] `/web fetch` allowed fake URL appends trace and prints title/body metadata
 *   [10E8-trace-redact] `/web trace` redacts secrets in query/url/reason
 *   [10E8-clear] `/web clear` empties trace without touching disk
 *   [10E8-output-bounded] command output is bounded
 *
 * RED ANCHOR: imports from src/web/webCommands.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  webStatus,
  webSearch,
  webFetch,
  webTrace,
  webClear,
  type WebCommandContext,
  type WebCommandMeta,
} from "../../src/web/webCommands.js";
import { createManualProvider, noneProvider } from "../../src/web/searchProvider.js";
import type { WebConfig } from "../../src/config/webConfig.js";
import type { WebTraceRecord } from "../../src/web/trace.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function disabledWebConfig(): WebConfig {
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
  };
}

function enabledWebConfig(overrides?: Partial<WebConfig>): WebConfig {
  return {
    enabled: true,
    searchProvider: "manual",
    fetchEnabled: true,
    allowedDomains: ["example.com"],
    blockedDomains: [],
    maxResults: 5,
    maxFetchBytes: 200000,
    maxReturnedChars: 12000,
    timeoutMs: 15000,
    redirects: 3,
    quarantine: true,
    ...overrides,
  };
}

const emptyTrace: WebTraceRecord[] = [];

const defaultMeta: WebCommandMeta = {
  recordId: "cmd-1",
  fetchedAt: "2026-06-21T00:00:00Z",
};

function makeContext(config: WebConfig, overrides?: Partial<WebCommandContext>): WebCommandContext {
  return {
    config,
    searchProvider: noneProvider,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// [10E8-status]  /web status shows disabled defaults
// ---------------------------------------------------------------------------

test("[10E8-status] /web status shows disabled defaults with enable hint", () => {
  const r = webStatus(disabledWebConfig());
  assert.equal(r.kind, "message");
  assert.ok(r.title!.includes("disabled"), "title mentions disabled");
  assert.ok(r.body!.includes("DEEPCODER_WEB=1"), "body contains enable hint");
  assert.ok(r.body!.includes("web.enabled=true"), "body contains config key hint");
});

test("[10E8-status-on] /web status shows all fields when enabled", () => {
  const r = webStatus(enabledWebConfig({ searchProvider: "test-search" }));
  assert.equal(r.kind, "table");
  assert.ok(r.title!.includes("Web access"), "title is Web access");
  assert.ok(r.rows, "rows present");
  const rows = r.rows!;
  assert.ok(rows.some((row) => row[0] === "enabled" && row[1] === "yes"), "shows enabled");
  assert.ok(rows.some((row) => row[0] === "search provider" && row[1] === "test-search"), "shows search provider");
  assert.ok(rows.some((row) => row[0] === "fetch" && row[1] === "enabled"), "shows fetch enabled");
  assert.ok(rows.some((row) => row[0] === "max results" && row[1] === "5"), "shows max results");
  assert.ok(rows.some((row) => row[0] === "quarantine" && row[1] === "on"), "shows quarantine on");
});

test("[10E8-status-on] /web status shows fetch disabled when config.fetchEnabled is false", () => {
  const r = webStatus(enabledWebConfig({ fetchEnabled: false }));
  assert.equal(r.kind, "table");
  const fetchRow = r.rows!.find((row) => row[0] === "fetch");
  assert.ok(fetchRow);
  assert.equal(fetchRow![1], "disabled");
});

// ---------------------------------------------------------------------------
// [10E8-search-disabled]  /web search refuses when web disabled
// ---------------------------------------------------------------------------

test("[10E8-search-disabled] /web search refuses when web disabled", async () => {
  const ctx = makeContext(disabledWebConfig());
  const { result, trace } = await webSearch("test query", ctx, defaultMeta, emptyTrace);
  assert.equal(result.kind, "message");
  assert.equal(result.severity, "error");
  assert.ok(result.title!.includes("Web search"));
  assert.ok(result.body!.includes("disabled"), "mentions disabled");
  // Trace must NOT be mutated on refusal
  assert.equal(trace, emptyTrace, "same array reference on disabled refusal");
});

// ---------------------------------------------------------------------------
// [10E8-search-none]  /web search refuses with provider "none"
// ---------------------------------------------------------------------------

test("[10E8-search-none] /web search refuses when provider is none", async () => {
  const ctx = makeContext(enabledWebConfig({ searchProvider: "none" }), {
    searchProvider: noneProvider,
  });
  const { result, trace } = await webSearch("test query", ctx, defaultMeta, emptyTrace);
  assert.equal(result.kind, "message");
  assert.equal(result.severity, "error");
  assert.ok(result.body!.includes("no search provider configured"));
  // Trace should be appended (a failed trace record)
  assert.equal(trace.length, 1, "trace record appended even on refusal");
  assert.equal(trace[0]!.kind, "search");
  assert.equal(trace[0]!.blocked, true);
});

// ---------------------------------------------------------------------------
// [10E8-search-ok]  /web search with manual provider appends trace + bounded
// ---------------------------------------------------------------------------

test("[10E8-search-ok] /web search with manual provider returns bounded results and appends trace", async () => {
  const manual = createManualProvider([
    { title: "Result A", url: "https://example.com/a", snippet: "Description for A" },
    { title: "Result B", url: "https://example.com/b", snippet: "Description for B with extra details here" },
  ]);
  const ctx = makeContext(enabledWebConfig(), { searchProvider: manual });
  const { result, trace } = await webSearch("test query", ctx, defaultMeta, emptyTrace);

  // Results should be displayed as message
  assert.equal(result.kind, "message");
  assert.ok(result.title!.includes("2 result(s)"));
  assert.ok(result.body!.includes("Result A"));
  assert.ok(result.body!.includes("https://example.com/a"));
  assert.ok(result.body!.includes("Description for A"));

  // Trace appended
  assert.equal(trace.length, 1, "trace record appended");
  assert.equal(trace[0]!.kind, "search");
  assert.equal(trace[0]!.query, "test query");
  assert.equal(trace[0]!.resultCount, 2);
  assert.equal(trace[0]!.blocked, false);
});

test("[10E8-search-ok] /web search results are bounded by maxResults", async () => {
  const manyResults = Array.from({ length: 20 }, (_, i) => ({
    title: `Result ${i}`,
    url: `https://example.com/${i}`,
    snippet: `Snippet for result ${i}`,
  }));
  const manual = createManualProvider(manyResults);
  const ctx = makeContext(enabledWebConfig({ maxResults: 3 }), { searchProvider: manual });
  const { result, trace } = await webSearch("lots", ctx, defaultMeta, emptyTrace);

  // Only 3 results should appear
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.resultCount, 3, "only 3 results");

  // Check that r4 doesn't appear
  assert.ok(result.body!.includes("r1"), "first result present");
  assert.ok(result.body!.includes("r3"), "third result present");
  assert.ok(!result.body!.includes("r4"), "fourth result should NOT appear");
});

// ---------------------------------------------------------------------------
// [10E8-fetch-blocked]  /web fetch blocked URL appends blocked trace
// ---------------------------------------------------------------------------

test("[10E8-fetch-blocked] /web fetch blocked URL appends blocked trace and prints reason", async () => {
  const fetchImpl = (async () => new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })) as unknown as typeof fetch;

  const ctx = makeContext(
    enabledWebConfig({ allowedDomains: [], blockedDomains: ["evil.example.com"] }),
    { fetchImpl },
  );

  const { result, trace } = await webFetch(
    "https://evil.example.com/malware",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  // Should be blocked
  assert.equal(result.kind, "message");
  assert.ok(result.title!.includes("blocked"), "title mentions blocked");
  assert.ok(result.body!.includes("blocked domain"), "body mentions blocked domain");

  // Trace should be appended with blocked marker
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.kind, "fetch");
  assert.equal(trace[0]!.url, "https://evil.example.com/malware");
  assert.equal(trace[0]!.blocked, true);
  assert.ok(trace[0]!.reason, "reason present");
});

// ---------------------------------------------------------------------------
// [10E8-fetch-ok]  /web fetch allowed URL appends trace and shows metadata
// ---------------------------------------------------------------------------

test("[10E8-fetch-ok] /web fetch allowed fake URL appends trace and prints title/body metadata", async () => {
  const htmlBody = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body><p>Hello world content here.</p></body></html>`;

  const fetchImpl = (async () => new Response(htmlBody, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  })) as unknown as typeof fetch;

  const ctx = makeContext(enabledWebConfig({ allowedDomains: ["example.com"] }), {
    fetchImpl,
  });

  const { result, trace } = await webFetch(
    "https://example.com/test",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  // Should succeed
  assert.equal(result.kind, "message");
  assert.equal(result.title, "Web fetch");
  assert.ok(result.body!.includes("Test Page"), "title shown");
  assert.ok(result.body!.includes("Source:"), "source shown");
  assert.ok(result.body!.includes("Hello world"), "body text shown");
  assert.ok(result.body!.includes("quarantined"), "quarantine marker shown");

  // Trace appended with fetch metadata
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.kind, "fetch");
  assert.equal(trace[0]!.url, "https://example.com/test");
  assert.equal(trace[0]!.title, "Test Page");
  assert.ok(trace[0]!.bytesRead !== undefined);
  assert.ok(trace[0]!.charsReturned !== undefined);
  assert.equal(trace[0]!.blocked, undefined);
});

test("[10E8-fetch-ok] /web fetch refuses when fetch disabled", async () => {
  const fetchImpl = (async () => new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })) as unknown as typeof fetch;

  const ctx = makeContext(
    enabledWebConfig({ fetchEnabled: false }),
    { fetchImpl },
  );

  const { result, trace } = await webFetch(
    "https://example.com/ok",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  assert.equal(result.kind, "message");
  assert.equal(result.severity, "error");
  assert.ok(result.body!.includes("fetch is disabled"));
  // Trace not mutated
  assert.equal(trace, emptyTrace, "trace unchanged on fetch-disabled refusal");
});

test("[10E8-fetch-ok] /web fetch refuses when web disabled", async () => {
  const ctx = makeContext(disabledWebConfig());
  const { result, trace } = await webFetch(
    "https://example.com/ok",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  assert.equal(result.kind, "message");
  assert.equal(result.severity, "error");
  assert.ok(result.body!.includes("disabled"));
  assert.equal(trace, emptyTrace, "trace unchanged on web-disabled refusal");
});

// ---------------------------------------------------------------------------
// [10E8-trace-redact]  /web trace redacts secrets in query/url/reason
// ---------------------------------------------------------------------------

test("[10E8-trace-redact] /web trace redacts secrets in query and url", () => {
  const records: WebTraceRecord[] = [
    {
      id: "leak-1",
      kind: "search",
      query: "my api key is sk-ABCDEF0123456789",
      fetchedAt: "2026-06-21T00:00:00Z",
    },
    {
      id: "leak-2",
      kind: "fetch",
      url: "https://example.com/?token=sk-ABCDEF0123456789",
      blocked: true,
      reason: "sk-ABCDEF0123456789 was blocked",
      fetchedAt: "2026-06-21T00:00:01Z",
    },
  ];

  const r = webTrace(records);
  assert.equal(r.kind, "message");
  assert.equal(r.title, "Web trace");

  // Redacted output must not leak the raw key
  assert.ok(!r.body!.includes("sk-ABCDEF0123456789"), "raw key must not appear");
  assert.ok(r.body!.includes("sk-***"), "redacted key marker appears");
});

test("[10E8-trace-redact] /web trace with empty trace returns clean message", () => {
  const r = webTrace([]);
  assert.equal(r.kind, "message");
  assert.ok(r.body!.includes("no web activity"), "empty trace message");
});

// ---------------------------------------------------------------------------
// [10E8-clear]  /web clear empties trace without touching disk
// ---------------------------------------------------------------------------

test("[10E8-clear] /web clear returns empty trace and confirmation", () => {
  const { trace, result } = webClear();
  assert.deepEqual(trace, [], "trace is empty array");
  assert.equal(result.kind, "message");
  assert.equal(result.title, "Web clear");
  assert.ok(result.body!.includes("cleared"), "confirmation mentions cleared");
});

test("[10E8-clear] /web clear does not reference disk or filesystem", () => {
  const { trace, result } = webClear();
  assert.deepEqual(trace, []);
  assert.equal(result.kind, "message");
  // No disk-related words
  assert.ok(!result.body!.toLowerCase().includes("file"));
  assert.ok(!result.body!.toLowerCase().includes("disk"));
  assert.ok(!result.body!.toLowerCase().includes("persist"));
});

// ---------------------------------------------------------------------------
// [10E8-output-bounded]  command output is bounded
// ---------------------------------------------------------------------------

test("[10E8-output-bounded] search result snippets are bounded to 200 chars", async () => {
  const longSnippet = "A".repeat(500);
  const manual = createManualProvider([
    { title: "Long", url: "https://example.com/long", snippet: longSnippet },
  ]);
  const ctx = makeContext(enabledWebConfig(), { searchProvider: manual });
  const { result } = await webSearch("query", ctx, defaultMeta, emptyTrace);

  assert.equal(result.kind, "message");
  assert.ok(result.body!.length < 1000, "body is bounded");
  // Snippet should be truncated with …
  assert.ok(result.body!.includes("…") || !result.body!.includes("AAAAA"), "snippet was bounded");
});

test("[10E8-output-bounded] fetch body is bounded to MAX_BODY_CHARS", async () => {
  const hugeBody = "Hello world! ".repeat(1000); // ~13,000 chars
  const fetchImpl = (async () => new Response(hugeBody, {
    status: 200,
    headers: { "content-type": "text/plain" },
  })) as unknown as typeof fetch;

  const ctx = makeContext(enabledWebConfig({ allowedDomains: ["example.com"] }), {
    fetchImpl,
  });

  const { result } = await webFetch(
    "https://example.com/big",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  assert.equal(result.kind, "message");
  assert.ok(result.body!.length < 2000, "fetch body is bounded");
});

// ---------------------------------------------------------------------------
// [10E8-fetch-error]  /web fetch returns error for bad URLs
// ---------------------------------------------------------------------------

test("[10E8-fetch-error] /web fetch returns error when fetch fails", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;

  const ctx = makeContext(enabledWebConfig({ allowedDomains: ["example.com"] }), {
    fetchImpl,
  });

  const { result, trace } = await webFetch(
    "https://example.com/down",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  assert.equal(result.kind, "message");
  assert.equal(result.severity, "error");
  // Trace should be appended with error info
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.kind, "fetch");
  assert.equal(trace[0]!.blocked, undefined);
  assert.ok(trace[0]!.reason);
});

// ---------------------------------------------------------------------------
// [10E8-search-error]  /web search redacts query in displayed errors
// ---------------------------------------------------------------------------

test("[10E8-search-error] /web search redacts query in errors", async () => {
  // The noneProvider returns ok:false with "no search provider configured"
  const ctx = makeContext(enabledWebConfig({ searchProvider: "none" }), {
    searchProvider: noneProvider,
  });
  const { result } = await webSearch(
    "secret-password-is-sk-ABCDEF0123456789",
    ctx,
    defaultMeta,
    emptyTrace,
  );

  // Error should not contain the raw key
  assert.ok(!result.body!.includes("sk-ABCDEF0123456789"), "secret not leaked in error");
});

// ---------------------------------------------------------------------------
// [10E8-trace-append]  multiple commands accumulate trace
// ---------------------------------------------------------------------------

test("[10E8-trace-append] multiple web commands accumulate trace records", async () => {
  const manual = createManualProvider([
    { title: "A", url: "https://example.com/a", snippet: "snippet a" },
  ]);
  const ctx = makeContext(enabledWebConfig(), { searchProvider: manual });

  let trace: WebTraceRecord[] = [];

  // First search
  ({ trace } = await webSearch("first query", ctx, defaultMeta, trace));
  assert.equal(trace.length, 1);

  // Second search (different id)
  ({ trace } = await webSearch("second query", ctx, { recordId: "cmd-2", fetchedAt: "2026-06-21T00:00:01Z" }, trace));
  assert.equal(trace.length, 2, "trace accumulates");

  // Clear
  const cleared = webClear();
  assert.equal(cleared.trace.length, 0);
});
