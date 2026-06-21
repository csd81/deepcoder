/**
 * Phase 10E — web_search tool w913rapper (read-only, no network, no registry wiring).
 *
 * Wraps runWebSearch (src/web/searchProvider.ts) as a Tool. Refuses when no
 * provider is configured; formats provider results (title/url/snippet) for the
 * model. Security/redaction is delegated to runWebSearch.
 *
 * RED ANCHOR: imports from src/tools/webSearch.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool } from "../../src/tools/webSearch.js";
import { noneProvider, createManualProvider } from "../../src/web/searchProvider.js";

function exec(tool: ReturnType<typeof createWebSearchTool>, args: unknown) {
  return tool.build(args).execute({ signal: new AbortController().signal } as never);
}

test("[10E-searchtool-none] refuses when the provider is 'none'", async () => {
  const tool = createWebSearchTool({ provider: noneProvider });
  const r = await exec(tool, { query: "typescript 5.5 release" });
  assert.equal(r.isError, true);
});

test("[10E-searchtool-results] formats manual provider results (title + url + snippet)", async () => {
  const provider = createManualProvider([
    { title: "TS Docs", url: "https://example.com/ts", snippet: "the snippet" },
  ]);
  const tool = createWebSearchTool({ provider });
  const r = await exec(tool, { query: "ts" });
  assert.notEqual(r.isError, true);
  assert.match(r.output, /TS Docs/);
  assert.match(r.output, /example\.com\/ts/);
  assert.match(r.output, /the snippet/);
});
