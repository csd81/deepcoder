# Phase 10E — Read-Only Web Search and Fetch

## Context

Deepcoder can search and read the local workspace, query MCP servers, use semantic search, and run
shell commands under sandbox policy. It does not currently have a native web research tool.

That gap matters for software engineering work where the answer is outside the repo: breaking SDK
changes, new framework behavior, upstream issue tracker discussions, package documentation, API
deprecations, security advisories, and install/runtime errors caused by third-party systems.

This phase adds a safe, opt-in, read-only web capability. It should be useful for research and bug
diagnosis without turning the model into a general network execution path. Web results are cited,
bounded, redacted, and optionally quarantined from persistent assistant history.

## Goals

- Add native read-only `web_search` and `web_fetch` tools.
- Keep web access opt-in and policy-governed.
- Enforce domain allow/block rules, timeout, byte caps, MIME filtering, and redirect limits.
- Return citation-friendly summaries/snippets, not unlimited page dumps.
- Record an auditable web trace per session.
- Preserve privacy: do not send workspace files or secrets to search providers.
- Make the feature usable by researcher/explorer subagents without granting mutation or shell access.

## Non-goals

- No browser automation.
- No authenticated web sessions.
- No cookie jar.
- No posting/forms/mutations.
- No arbitrary `curl` replacement.
- No scraping paywalled/private content.
- No automatic web use by default.

## Config

Extend `.deepcoder/config.json`:

```json
{
  "web": {
    "enabled": false,
    "searchProvider": "none",
    "fetchEnabled": true,
    "allowedDomains": ["docs.python.org", "nodejs.org", "github.com"],
    "blockedDomains": ["localhost", "127.0.0.1", "169.254.169.254"],
    "maxResults": 5,
    "maxFetchBytes": 200000,
    "maxReturnedChars": 12000,
    "timeoutMs": 15000,
    "redirects": 3,
    "quarantine": true
  }
}
```

Environment overrides:

- `DEEPCODER_WEB=1|0`
- `DEEPCODER_WEB_SEARCH_PROVIDER=<provider>`
- `DEEPCODER_WEB_ALLOWED_DOMAINS=comma,separated`
- `DEEPCODER_WEB_BLOCKED_DOMAINS=comma,separated`

Default: disabled.

## Search Providers

Provider interface:

`src/web/searchProvider.ts`

```ts
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  name: string;
  search(query: string, opts: WebSearchOptions): Promise<WebSearchResult[]>;
}
```

Initial providers:

1. `none` — default, search disabled.
2. `tavily` or other API-backed provider only if configured explicitly later.
3. `manual` provider for tests/fakes.

Important: search queries must come from the user/model prompt, not from raw workspace file dumps.
The tool schema should tell the model not to paste secrets, file contents, or private code into
queries.

If no search provider is configured, `web_fetch` can still fetch explicitly provided URLs when web
is enabled and the domain policy allows them.

## Tools

### `web_search`

Kind: `read-only`

Schema:

```ts
{
  query: string;
  domains?: string[];
  maxResults?: number;
  recencyDays?: number;
}
```

Behavior:

- Requires `config.web.enabled` and a configured search provider.
- Query length capped.
- Domain filters must be subsets of allowed domains when allowlist is non-empty.
- Results are normalized, deduped by canonical URL, redacted, and bounded.
- Output contains title, URL, snippet, source, and result id.

### `web_fetch`

Kind: `read-only`

Schema:

```ts
{
  url: string;
  maxChars?: number;
  extract?: "text" | "markdown" | "metadata";
}
```

Behavior:

- Requires `config.web.enabled` and `fetchEnabled`.
- Only `http:` and `https:`.
- Blocks IP literals and private/link-local addresses by default.
- Blocks localhost and metadata endpoints.
- Applies allowed/blocked domain policy before and after redirects.
- MIME allowlist: text/html, text/plain, text/markdown, application/json under cap.
- Strips scripts/styles and returns bounded readable text/markdown.
- Redacts secrets in output.
- Records citation metadata.

## Domain Policy

New module:

`src/web/policy.ts`

Rules:

- `blockedDomains` always wins.
- If `allowedDomains` is non-empty, only exact or subdomain matches are allowed.
- Deny IP literals unless explicitly allowed.
- Deny private ranges by default.
- Deny `localhost`, `.local`, link-local, and cloud metadata IPs by default.
- Re-check final URL after every redirect.

Tests should cover:

- `example.com` allow exact
- `docs.example.com` allow when `example.com` allowlisted
- `badexample.com` not allowed by `example.com`
- redirect from allowed domain to blocked domain denied
- IP/private/local denied

## Fetcher

New module:

`src/web/fetcher.ts`

Uses `globalThis.fetch` with an injectable test seam.

Safety:

- `AbortController` timeout.
- Max response bytes read from stream; abort beyond cap.
- Redirect limit.
- Content-Type validation.
- User-Agent: `Deepcoder/<version> (+local agent; read-only)`.
- No cookies or auth headers.
- No provider API keys sent.

HTML extraction:

- Minimal dependency-free extraction first: remove script/style/noscript, strip tags, decode common entities.
- Later optional: better readability extraction.

## Web Trace

New module:

`src/web/trace.ts`

```ts
export interface WebTraceRecord {
  id: string;
  kind: "search" | "fetch";
  query?: string;
  url?: string;
  finalUrl?: string;
  title?: string;
  fetchedAt: string;
  bytesRead?: number;
  charsReturned?: number;
  resultCount?: number;
  blocked?: boolean;
  reason?: string;
}
```

Session adds:

```ts
webTrace: WebTraceRecord[];
```

Persist in session snapshots, capped at 100 records.

Slash command:

```text
/web trace
/web on|off
/web domains
```

## Quarantine and History

When `web.quarantine` is true:

- Full fetched text is returned as a tool result for the current model turn.
- Persisted session history stores only a compact citation summary and trace id.
- This mirrors subagent review/research quarantine: useful context without permanently stuffing
  long external pages into history.

If quarantine is false, behavior matches normal tool results but still bounded.

## Subagent Integration

Add optional web access to selected read-only subagent profiles:

- researcher: allowed when `web.enabled` and profile opts in
- explorer: off by default
- reviewer: off by default
- triage: optional later for public error lookup

Do not add web tools to restricted registries by accident. Subagent profiles should list
`web_search`/`web_fetch` explicitly.

## Permissions

Both tools are `read-only`, but config-gated.

Permission policy remains unchanged:

- readonly mode allows them if registered
- auto/ask also allow them
- registration depends on config, so disabled web means no model-callable web tools exist

The safety boundary is domain/config policy, not interactive approval.

## Files

New:

- `src/web/types.ts`
- `src/web/policy.ts`
- `src/web/fetcher.ts`
- `src/web/searchProvider.ts`
- `src/web/trace.ts`
- `src/tools/webSearch.ts`
- `src/tools/webFetch.ts`
- `test/adversarial/web-tools.test.ts`

Edit:

- `src/config/config.ts`
- `src/config/fileConfig.ts`
- `src/tools/registry.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- `src/session/sessionStore.ts`
- `src/subagents/profiles.ts` only if researcher web access ships in this phase

## Tests

No real network required.

1. Web tools are not registered when disabled.
2. `web_search` refuses when enabled but no provider is configured.
3. Domain allowlist exact/subdomain behavior is correct.
4. Blocklist overrides allowlist.
5. Redirect to blocked domain is denied.
6. IP/private/local/metadata URLs are denied.
7. Fetch timeout returns bounded error, not throw.
8. Oversized response is truncated/aborted at cap.
9. Unsupported MIME is refused.
10. HTML extraction removes script/style text.
11. Output is redacted for key-shaped strings.
12. Session web trace is capped and persisted.
13. Quarantine stores compact citation summary instead of full page in persisted history.
14. Researcher profile only gets web tools when explicitly enabled.

## Rollout

### 10E.1 — Config and Policy

- Add `web` config schema/defaults/env.
- Add domain policy tests.

### 10E.2 — Fetcher and `web_fetch`

- Implement safe fetch, caps, extraction, redaction, trace.
- Register only when enabled.

### 10E.3 — Search Provider Interface and `web_search`

- Add provider interface and fake/manual provider tests.
- Keep real provider optional.

### 10E.4 — Session Trace and Slash Commands

- Add `/web trace`, `/web on|off`, `/web domains`.
- Persist capped trace.

### 10E.5 — Researcher Subagent Opt-in

- Allow researcher profile to include web tools when config enables it.
- Add adversarial injection tests.

## Acceptance Criteria

- Disabled by default.
- When enabled, `web_fetch` can fetch an allowed public documentation URL with bounded output.
- Domain policy blocks local/private/metadata targets.
- Web outputs are redacted and byte-capped.
- Session trace records citations without leaking secrets.
- Researcher can use web only when explicitly configured.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Which real search provider should be first, if any?
- Should `web_fetch` require explicit user approval for domains outside an allowlist, or simply deny?
- Should fetched content be indexed into semantic search later?
- Should web traces be exportable as citations in final answers?
