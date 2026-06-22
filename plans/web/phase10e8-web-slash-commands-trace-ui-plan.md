# Phase 10E.8 — `/web` Slash Commands and Trace UI

## Context

Deepcoder has the underlying web modules:

- `web_fetch` tool wrapper
- `web_search` tool wrapper
- domain/SSRF policy
- fetcher with caps/timeouts/MIME filtering
- web trace core
- registration tests proving web tools appear only when enabled

What is missing is a user-facing command surface for inspecting and controlling web activity.
Right now, the agent can use tools when enabled, but the human has no clean `/web` interface to
search, fetch, review trace records, or inspect why a URL was blocked.

## Goal

Add slash commands that make web use inspectable and controllable:

```text
/web status
/web search <query>
/web fetch <url>
/web trace
/web clear
```

These commands are human-facing. They should be useful even before the model decides to call
web tools.

## Non-Goals

- No browser UI.
- No persistent web cache.
- No authenticated web sessions.
- No mutation/posting.
- No enabling web by command unless config/env already allows it.

## Command Behavior

### `/web status`

Shows:

- enabled/disabled
- search provider
- fetch enabled/disabled
- allowed domains
- blocked domains
- max results
- max fetch bytes
- max returned chars
- quarantine on/off

If disabled, show the exact env/config hint:

```text
web: disabled
enable with DEEPCODER_WEB=1 or .deepcoder/config.json web.enabled=true
```

### `/web search <query>`

Runs the same `runWebSearch` path used by `web_search`.

Rules:

- refuses if web disabled
- refuses if no search provider configured
- redacts query in displayed errors
- appends a search record to session web trace
- displays bounded result list with ids

Output:

```text
r1  Title
    https://example.com/doc
    snippet...
```

### `/web fetch <url>`

Runs the same safe `fetchUrl` path used by `web_fetch`.

Rules:

- refuses if web disabled or fetch disabled
- applies domain policy and SSRF guard
- appends fetch record to session web trace
- displays title/source/truncation/quarantine metadata
- body output is bounded and marked untrusted

### `/web trace`

Displays compact trace summary:

- newest last
- one line per record
- search/fetch id
- query or final URL
- title if available
- blocked marker and reason
- bytes/chars/result count if available

Add optional flags later:

```text
/web trace --last 20
/web trace --json
```

### `/web clear`

Clears only the in-memory session trace. It must not delete files.

If persisted sessions later include web summaries, this command should not rewrite old session
history in v1.

## Session Model

Extend `Session` with:

```ts
webTrace: WebTraceRecord[];
```

Use existing `appendWebTrace` and `summarizeWebTrace`.

Persist only compact trace summaries if persistence is needed. Do not persist full fetched
page text by default.

## TUI Integration

If the scrollable TUI is active:

- render web records as collapsible blocks
- show blocked fetches in warning style
- show fetched content as untrusted/quoted
- status bar can include `web:on` or `web:off`

This phase may implement only plain slash-command output first. Full TUI widgets can follow.

## Tests

No real network required.

- `/web status` shows disabled defaults
- `/web search` refuses when disabled
- `/web search` refuses with provider `none`
- `/web search` with manual provider appends trace and prints bounded results
- `/web fetch` blocked URL appends blocked trace and prints reason
- `/web fetch` allowed fake URL appends trace and prints title/body metadata
- `/web trace` redacts secrets in query/url/reason
- `/web clear` empties trace without touching disk
- command output is bounded

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- no live network tests required
- manual smoke with fake/manual providers possible

Optional live smoke:

```bash
DEEPCODER_WEB=1 \
DEEPCODER_WEB_ALLOWED_DOMAINS=docs.python.org,nodejs.org \
npm run dev
```

Then:

```text
/web fetch https://docs.python.org/3/library/asyncio.html
/web trace
```

## Safety

- Slash commands do not bypass `web.enabled`.
- Slash commands use the same policy/fetch/search code as tools.
- Trace output is redacted.
- Full fetched content is bounded and quarantined.
- No cookies, auth headers, or local-network requests.

## Implementation Order

1. Add `webTrace` field to session state.
2. Add pure render helpers for status/result/trace output.
3. Add `/web status`, `/web trace`, `/web clear`.
4. Add `/web fetch` using injected/fakeable fetch seam.
5. Add `/web search` using provider factory.
6. Add adversarial tests for refusals, trace append, redaction, and bounded output.
7. Add README docs.

