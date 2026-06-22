# Phase 10E.6 — Real Web Search Provider Backend

## Context

Deepcoder has the `web_search` tool wrapper and `runWebSearch` normalization pipeline:

- query validation
- result dedupe by canonical URL
- result caps
- secret redaction
- stable result ids
- default refusal through `noneProvider`

What is missing is a real search backend. Today, `web_search` can only use test/manual
providers or refuse with "no search provider configured". That means Deepcoder can fetch a URL
when given one, but cannot independently discover relevant pages from a query.

## Goal

Add one real, opt-in web search provider so Deepcoder can search public web results and then
use `web_fetch` to inspect selected URLs.

Recommended first backend: Brave Search API.

Reasons:

- straightforward HTTP JSON API
- independent from model providers
- common documentation/search use case
- provider key can be isolated as `BRAVE_SEARCH_API_KEY`
- easy to fake in tests via injected fetch seam

Alternative provider names should remain possible later: `kagi`, `tavily`, `serpapi`,
`exa`.

## Non-Goals

- No browser automation.
- No scraping search-result HTML pages.
- No authenticated/private web.
- No automatic web search by default.
- No sending workspace file contents as search queries.
- No persistent search-result cache in this phase.

## Config

Extend the existing web config behavior:

```json
{
  "web": {
    "enabled": false,
    "searchProvider": "brave",
    "maxResults": 5,
    "allowedDomains": [],
    "blockedDomains": ["localhost", "127.0.0.1", "169.254.169.254"]
  }
}
```

Environment:

```text
DEEPCODER_WEB=1
DEEPCODER_WEB_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=...
```

Provider key isolation:

- `BRAVE_SEARCH_API_KEY` satisfies only the Brave search provider.
- It must never be forwarded to model providers.
- It must never appear in tool output, traces, test snapshots, or errors.

## Design

### 1. Provider Module

New file:

```text
src/web/providers/brave.ts
```

Exports:

```ts
export interface BraveSearchOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createBraveSearchProvider(opts: BraveSearchOptions): WebSearchProvider;
```

Implementation:

- call Brave's web search endpoint with `q`, `count`, optional freshness/recency if supported
- pass key in request headers only
- never put key in URL/query params
- support injected `fetchImpl` for no-network tests
- timeout via `AbortController`
- map results into `WebSearchResult`
- preserve provider name as `brave`
- treat non-2xx responses as empty/refused with a bounded reason

### 2. Provider Factory

New file:

```text
src/web/providerFactory.ts
```

Responsibilities:

- map `config.web.searchProvider` to a concrete `WebSearchProvider`
- default `none`
- `brave` requires `BRAVE_SEARCH_API_KEY`
- provider construction is fail-closed:
  - if web disabled -> `noneProvider`
  - if provider unknown -> `noneProvider` plus clear reason in logs/status later
  - if provider key missing -> `noneProvider`

The factory should be pure/testable except for reading env through explicit parameters.

### 3. Runtime Wiring

Update `buildSession` web tool registration:

- if `web.enabled`, build search provider through `createWebSearchProviderFromConfig`
- pass that provider into `createWebTools`
- preserve current default-off behavior

No subagent gets web tools unless the existing explicit web opt-in gate allows it.

### 4. Query Guardrails

Before provider call:

- reuse `MAX_QUERY_CHARS`
- reject empty queries
- optionally reject queries containing obvious secret-like strings before they leave the
  process
- cap `maxResults` to config max
- if `domains` are provided, ensure they are compatible with `allowedDomains` when allowlist is
  non-empty

The query itself should not be logged raw unless redacted.

### 5. Output Shape

Keep current `web_search` output format:

```text
[r1] Title
https://example.com/doc
snippet...
```

Add provider/source only if it is useful and bounded:

```text
source: brave
```

The output is for discovery only. The model should use `web_fetch` for full page content.

## Tests

No live network required.

Add tests:

- provider maps Brave JSON results into `WebSearchResult`
- key is sent as a header, never in URL
- missing key refuses/falls back without throwing
- non-2xx response returns bounded error/refusal
- timeout aborts and returns bounded error
- search output redacts key-shaped snippets
- domain filters are capped/validated
- web disabled keeps `web_search` unregistered
- web enabled + brave config registers `web_search`

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- `DEEPCODER_WEB=1 DEEPCODER_WEB_SEARCH_PROVIDER=brave` with no key refuses clearly
- Optional manual smoke with a real key:

```bash
DEEPCODER_WEB=1 \
DEEPCODER_WEB_SEARCH_PROVIDER=brave \
BRAVE_SEARCH_API_KEY=... \
npm run dev -- "search the web for Node.js test runner mocking docs and summarize sources"
```

## Safety

- Web remains disabled by default.
- Search provider is explicit opt-in.
- Provider key is env-only.
- Query and result text are redacted before model-visible output.
- Search only returns snippets; full pages still go through `web_fetch` policy and quarantine.

## Implementation Order

1. Add Brave provider module with injected fetch seam.
2. Add provider factory.
3. Wire provider factory into `buildSession`.
4. Add adversarial tests for key isolation, timeout, redaction, missing-key refusal.
5. Add README usage docs.

