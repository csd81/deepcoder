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
 *
 * RED ANCHOR: imports from src/web/searchProvider.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runWebSearch,
  noneProvider,
  createManualProvider,
} from "../../src/web/searchProvider.js";

test("[10E3-none] the none provider refuses with no results", async () => {
  const r = await runWebSearch("typescript 5.5 release notes", {}, noneProvider);
  assert.equal(r.ok, false, "no provider configured -> refuse");
  assert.equal(r.results.length, 0);
});

test("[10E3-dedupe] results with the same canonical URL are deduped", async () => {
  const provider = createManualProvider([
    { title: "A", url: "https://example.com/docs", snippet: "one" },
    { title: "B", url: "https://example.com/docs/", snippet: "dup of one (trailing slash)" },
    { title: "C", url: "https://example.com/other", snippet: "two" },
  ]);
  const r = await runWebSearch("q", { maxResults: 10 }, provider);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2, "trailing-slash duplicate collapsed");
});
