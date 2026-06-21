/**
 * Phase 10E slice 3 — web search provider interface + web_search core (pure, no network).
 *
 * Defines the WebSearchProvider seam (none + manual/fake providers) and the
 * normalization pipeline runWebSearch uses: query cap, dedupe by canonical URL,
 * maxResults cap, redaction, stable result ids. No real provider, no network.
 *
 * Deliverables (each tagged [10E3-*]):
 *   [10E3-none]     the `none` provider refuses (ok:false, no results)
 *   [10E3-querycap] an over-long query is rejected/capped
 *   [10E3-dedupe]   results with the same canonical URL are deduped
 *   [10E3-cap]      results beyond maxResults are dropped
 *   [10E3-redact]   title/snippet are redacted for key-shaped strings
 *   [10E3-manual]   a manual provider returns injected results through the pipeline
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runWebSearch,
  noneProvider,
  createManualProvider,
  MAX_QUERY_CHARS,
  type WebSearchProvider,
  type WebSearchResult,
} from "../../src/web/searchProvider.js";

// ---------------------------------------------------------------------------
// [10E3-none]  the `none` provider refuses (ok:false, no results)
// ---------------------------------------------------------------------------

test("[10E3-none] noneProvider refuses", async () => {
  const r = await runWebSearch("typescript 5.5 release notes", {}, noneProvider);
  assert.equal(r.ok, false, "no provider configured -> refuse");
  assert.equal(r.reason, "no search provider configured");
  assert.equal(r.results.length, 0);
});

test("[10E3-none] noneProvider.search() itself resolves to empty array", async () => {
  const results = await noneProvider.search("anything", {});
  assert.equal(results.length, 0);
});

test("[10E3-none] a provider with name 'none' also refuses", async () => {
  const customNone: WebSearchProvider = {
    name: "none",
    async search() {
      // This would return something, but runWebSearch should bail before calling it
      return [{ title: "leak", url: "http://evil", snippet: "should not appear" }];
    },
  };
  const r = await runWebSearch("test", {}, customNone);
  assert.equal(r.ok, false, "name=’none’ → refuse");
  assert.equal(r.reason, "no search provider configured");
  assert.equal(r.results.length, 0, "no results even though provider would return one");
});

// ---------------------------------------------------------------------------
// [10E3-querycap]  an over-long / empty query is rejected
// ---------------------------------------------------------------------------

test("[10E3-querycap] empty query is rejected", async () => {
  const provider = createManualProvider([{ title: "x", url: "http://a", snippet: "x" }]);
  const r = await runWebSearch("", {}, provider);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty query");
  assert.equal(r.results.length, 0);
});

test("[10E3-querycap] whitespace-only query is rejected", async () => {
  const provider = createManualProvider([{ title: "x", url: "http://a", snippet: "x" }]);
  const r = await runWebSearch("   ", {}, provider);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty query");
  assert.equal(r.results.length, 0);
});

test("[10E3-querycap] over-long query is rejected", async () => {
  const provider = createManualProvider([{ title: "x", url: "http://a", snippet: "x" }]);
  // Build a query longer than MAX_QUERY_CHARS
  const long = "a".repeat(MAX_QUERY_CHARS + 1);
  const r = await runWebSearch(long, {}, provider);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "query too long");
  assert.equal(r.results.length, 0);
});

test("[10E3-querycap] query exactly at MAX_QUERY_CHARS is allowed", async () => {
  const provider = createManualProvider([{ title: "x", url: "http://a", snippet: "x" }]);
  const exact = "a".repeat(MAX_QUERY_CHARS);
  const r = await runWebSearch(exact, {}, provider);
  assert.equal(r.ok, true, "exact-length query should be allowed");
});

// ---------------------------------------------------------------------------
// [10E3-dedupe]  results with the same canonical URL are deduped
// ---------------------------------------------------------------------------

test("[10E3-dedupe] trailing-slash duplicate collapsed", async () => {
  const provider = createManualProvider([
    { title: "A", url: "https://example.com/docs", snippet: "one" },
    { title: "B", url: "https://example.com/docs/", snippet: "dup of one (trailing slash)" },
    { title: "C", url: "https://example.com/other", snippet: "two" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2, "trailing-slash duplicate collapsed");
  assert.equal(r.results[0].title, "A", "first occurrence kept");
  assert.equal(r.results[1].title, "C", "third result kept");
});

test("[10E3-dedupe] case-insensitive host dedupes", async () => {
  const provider = createManualProvider([
    { title: "X", url: "https://Example.COM/path", snippet: "same" },
    { title: "Y", url: "https://example.com/path", snippet: "dup" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1, "different-case hosts are the same");
  assert.equal(r.results[0].title, "X", "first occurrence kept");
});

test("[10E3-dedupe] fragment is ignored for dedup", async () => {
  const provider = createManualProvider([
    { title: "A", url: "https://example.com/page", snippet: "first" },
    { title: "B", url: "https://example.com/page#section", snippet: "dup with fragment" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.results.length, 1, "fragment does not create separate entry");
});

test("[10E3-dedupe] unparseable URL is dropped", async () => {
  const provider = createManualProvider([
    { title: "Bad", url: "not a valid url", snippet: "garbage" },
    { title: "Good", url: "https://example.com/valid", snippet: "fine" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].title, "Good");
});

// ---------------------------------------------------------------------------
// [10E3-cap]  results beyond maxResults are dropped
// ---------------------------------------------------------------------------

test("[10E3-cap] caps at maxResults (default 5)", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `R${i}`,
    url: `https://example.com/r${i}`,
    snippet: `result ${i}`,
  }));
  const provider = createManualProvider(many);
  const r = await runWebSearch("q", {}, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 5, "default maxResults is 5");
  assert.equal(r.results[0].id, "r1");
  assert.equal(r.results[4].id, "r5");
});

test("[10E3-cap] respects explicit maxResults", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `R${i}`,
    url: `https://example.com/r${i}`,
    snippet: `result ${i}`,
  }));
  const provider = createManualProvider(many);
  const r = await runWebSearch("q", { maxResults: 3 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].id, "r1");
  assert.equal(r.results[2].id, "r3");
});

test("[10E3-cap] maxResults = 0 returns zero results", async () => {
  const provider = createManualProvider([
    { title: "A", url: "https://example.com/a", snippet: "a" },
  ]);
  const r = await runWebSearch("q", { maxResults: 0 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 0);
});

// ---------------------------------------------------------------------------
// [10E3-redact]  title/snippet are redacted for key-shaped strings
// ---------------------------------------------------------------------------

test("[10E3-redact] sk-... in snippet is redacted", async () => {
  const provider = createManualProvider([
    { title: "Leaky page", url: "https://example.com/leak", snippet: "my key is sk-ABCDEF0123456789" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].snippet, /sk-\*\*\*/);
  assert.doesNotMatch(r.results[0].snippet, /sk-ABCDEF0123456789/);
});

test("[10E3-redact] sk-... in title is redacted", async () => {
  const provider = createManualProvider([
    { title: "sk-ABCDEF0123456789 is my key", url: "https://example.com/k", snippet: "innocent" },
  ]);
  const r = await runWebSearch("q", {}, provider);
  assert.equal(r.ok, true);
  assert.match(r.results[0].title, /sk-\*\*\*/);
  assert.doesNotMatch(r.results[0].title, /sk-ABCDEF0123456789/);
});

// ---------------------------------------------------------------------------
// [10E3-manual]  manual provider returns injected results through pipeline
// ---------------------------------------------------------------------------

test("[10E3-manual] manual provider e2e with ids", async () => {
  const results: WebSearchResult[] = [
    { title: "Alpha", url: "https://example.com/alpha", snippet: "first result" },
    { title: "Beta", url: "https://example.com/beta", snippet: "second result" },
  ];
  const provider = createManualProvider(results);
  const r = await runWebSearch("test query", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2, "both results returned");
  assert.equal(r.results[0].id, "r1", "first result id is r1");
  assert.equal(r.results[1].id, "r2", "second result id is r2");
  assert.equal(r.results[0].title, "Alpha", "title preserved");
  assert.equal(r.results[1].snippet, "second result", "snippet preserved");
});

test("[10E3-manual] manual provider dedupe + cap + ids work together", async () => {
  const provider = createManualProvider([
    { title: "A", url: "https://example.com/a", snippet: "one" },
    { title: "B dup", url: "https://example.com/a/", snippet: "dup of a (trailing slash)" },
    { title: "C", url: "https://example.com/c", snippet: "three" },
    { title: "D", url: "https://example.com/d", snippet: "four" },
  ]);
  // Dedupe removes B (trailing-slash canonical). Cap to 2.
  const r = await runWebSearch("q", { maxResults: 2 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].id, "r1");
  assert.equal(r.results[0].title, "A");
  assert.equal(r.results[1].id, "r2");
  assert.equal(r.results[1].title, "C");
});

test("[10E3-manual] manual provider honours provider name", async () => {
  const provider = createManualProvider([
    { title: "X", url: "https://x.com/x", snippet: "x" },
  ]);
  assert.equal(provider.name, "manual");
});
