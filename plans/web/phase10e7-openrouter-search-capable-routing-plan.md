# Phase 10E.7 — OpenRouter Search-Capable Research Routing

## Context

Deepcoder has a plan for first-class OpenRouter provider support and already has local web
tool primitives. OpenRouter may expose models or routes that can perform web-aware research
through provider-side tools or search-enabled model behavior, depending on the selected model
and route.

This phase is not the generic OpenRouter provider. It is the safe integration pattern for
using OpenRouter as a research route without confusing model-generated claims with audited web
tool citations.

## Goal

Allow Deepcoder to use OpenRouter for research/planning roles while preserving the distinction
between:

- audited local `web_search` / `web_fetch` tool results
- model-provider responses that may have used provider-side search or may only be generated
  text

## Non-Goals

- No assumption that every OpenRouter model has live web access.
- No provider-side browser automation.
- No treating provider-generated citations as equivalent to Deepcoder `web_trace` records.
- No automatic search by default.
- No replacement for the local `web_search` provider backend.

## Design

### 1. Capability Metadata

Extend model routing metadata with optional capabilities:

```ts
interface ModelRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  capabilities?: {
    webAware?: boolean;
    toolCalling?: boolean;
    longContext?: boolean;
  };
}
```

This is declarative user/config metadata, not a trusted runtime fact.

Example:

```json
{
  "models": {
    "roles": {
      "research": {
        "provider": "openrouter",
        "model": "openrouter/auto",
        "capabilities": { "webAware": true, "longContext": true }
      }
    }
  }
}
```

### 2. Research Role Prompt Contract

When a route is marked `webAware`, the system prompt should require source handling:

- distinguish "provider-side source" from "Deepcoder-fetched source"
- include URLs when claiming external facts
- avoid quoting long copyrighted text
- ask to use local `web_fetch` when exact source text is required and web tools are available

Provider-side citations should be displayed as advisory, not as verified local trace records.

### 3. Local Trace Boundary

Only local `web_search` and `web_fetch` create `WebTraceRecord`.

OpenRouter/model-generated citations may be stored separately:

```ts
interface ProviderCitation {
  provider: string;
  model: string;
  url: string;
  title?: string;
  quotedAt?: string;
  verifiedByLocalFetch?: boolean;
}
```

Until verified with `web_fetch`, these citations must be labeled `unverified-provider-citation`.

### 4. Verification Flow

For high-stakes research:

1. Ask OpenRouter research route for candidate URLs and summary.
2. Use local `web_fetch` to fetch the most important URLs.
3. Feed the bounded fetched text back to the model.
4. Only then mark facts as locally verified.

This keeps OpenRouter useful for discovery while preserving Deepcoder's auditable web trace.

### 5. Config Examples

Cheap discovery:

```json
{
  "models": {
    "roles": {
      "research": {
        "provider": "openrouter",
        "model": "openrouter/free",
        "capabilities": { "webAware": false, "longContext": true }
      }
    }
  }
}
```

Paid research model:

```json
{
  "models": {
    "roles": {
      "research": {
        "provider": "openrouter",
        "model": "openrouter/auto",
        "capabilities": { "webAware": true, "toolCalling": true }
      }
    }
  }
}
```

## Tests

No live OpenRouter calls required.

- route parser accepts optional capabilities
- provider-side citations are not appended to `web_trace`
- provider-side citations render with an "unverified" marker
- prompt builder includes the local-fetch verification instruction for `webAware` routes
- local `web_fetch` trace records remain authoritative
- no provider citation text bypasses redaction

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- docs explain the difference between provider-side citations and locally verified web trace
- no runtime behavior changes unless the user configures OpenRouter research routing

## Safety

- Provider-side web claims are advisory until fetched locally.
- No workspace secrets are sent as search prompts automatically.
- No provider-side citation becomes a trusted `WebTraceRecord`.
- OpenRouter keys are provider-isolated and env-only.

## Implementation Order

1. Add route capability type and parsing tests.
2. Add provider-citation type and renderer.
3. Add prompt text for `webAware` research routes.
4. Add docs showing safe OpenRouter research workflow.
5. Optional follow-up: `/research verify-sources` command that fetches provider citations
   through local `web_fetch`.

