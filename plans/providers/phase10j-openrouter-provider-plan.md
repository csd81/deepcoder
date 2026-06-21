# Phase 10J — OpenRouter Provider

## Context

Deepcoder supports several providers through a common `ModelProvider` boundary. Most chat
providers that expose an OpenAI-compatible `/chat/completions` API reuse
`OpenAICompatibleProvider`.

OpenRouter is not wired yet, but it is a good fit for this architecture:

- API base URL: `https://openrouter.ai/api/v1`
- authentication: `Authorization: Bearer <OPENROUTER_API_KEY>`
- chat endpoint: OpenAI-compatible `/chat/completions`
- model ids use provider-prefixed slugs such as `openai/gpt-5.2`,
  `anthropic/claude-sonnet-4.6`, or router slugs.
- optional attribution headers:
  - `HTTP-Referer`
  - `X-Title`

Sources checked:

- <https://openrouter.ai/docs/api/reference/overview>
- <https://openrouter.ai/docs/api/reference/authentication>
- <https://openrouter.ai/docs/quickstart>
- <https://openrouter.ai/rankings?category=programming#categories>
- <https://openrouter.ai/collections/programming>
- <https://openrouter.ai/collections/free-models>
- <https://openrouter.ai/docs/guides/routing/routers/free-router>

## Goal

Add first-class `openrouter` provider support so users can run:

```bash
DEEPCODER_PROVIDER=openrouter \
OPENROUTER_API_KEY=... \
DEEPCODER_MODEL=anthropic/claude-sonnet-4.6 \
deepcoder "fix the bug"
```

without using the generic `openai-compatible` provider or manually setting
`DEEPCODER_BASE_URL`.

## Non-Goals

- No new tool loop.
- No OpenRouter SDK dependency.
- No OpenRouter OAuth flow.
- No model catalog sync in v1.
- No provider-ranking UI in v1.
- No automatic budget/fallback routing in v1.
- No BYOK provider-key management in v1.

## Design

### 1. Provider Config

Add provider name:

```text
openrouter
```

Add defaults:

```ts
OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
PROVIDER_DEFAULT_MODELS.openrouter = "openrouter/auto";
PROVIDER_ENV_PREFIX.openrouter = "OPENROUTER";
```

The default model can be revisited. `openrouter/auto` is convenient when users want
OpenRouter's managed routing; users can override with explicit slugs for deterministic model
choice.

OpenRouter also exposes `openrouter/free`, a router over currently available free models.
That is useful for low-stakes smoke tests, but it is not deterministic enough for benchmark
claims or delegated-worker comparisons. Prefer explicit model slugs for repeatable runs.

Env behavior:

- `DEEPCODER_PROVIDER=openrouter`
- `OPENROUTER_API_KEY` is accepted.
- `OPENROUTER_BASE_URL` overrides the default when needed.
- `OPENROUTER_MODEL` is accepted.
- generic `DEEPCODER_API_KEY`, `DEEPCODER_BASE_URL`, and `DEEPCODER_MODEL` still win.

Provider isolation rule:

- `DEEPSEEK_*`, `OPENAI_*`, `GEMINI_*`, etc. must not satisfy `openrouter`.
- `OPENROUTER_*` must not satisfy other providers.

### 2. Factory Wiring

Reuse `OpenAICompatibleProvider`:

```ts
case "openrouter":
  return new OpenAICompatibleProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || OPENROUTER_DEFAULT_BASE_URL,
    label: "OpenRouter",
    temperature: config.temperature,
    headers: openRouterAttributionHeaders(config),
  });
```

This requires extending `OpenAICompatibleProvider` with optional headers.

### 3. Optional Attribution Headers

OpenRouter supports optional attribution headers for leaderboard/ranking:

- `HTTP-Referer`
- `X-Title`

Config/env:

```text
OPENROUTER_HTTP_REFERER
OPENROUTER_APP_TITLE
DEEPCODER_OPENROUTER_HTTP_REFERER
DEEPCODER_OPENROUTER_APP_TITLE
```

Recommended defaults:

- no referer by default,
- `X-Title: Deepcoder` by default is acceptable only if tests prove it is not a secret and
  users can disable/override it. Conservative v1: omit both unless env/config sets them.

Implementation detail:

The OpenAI SDK supports default headers. Extend `OpenAICompatibleOptions`:

```ts
defaultHeaders?: Record<string, string>;
```

Then:

```ts
new OpenAI({
  apiKey: opts.apiKey,
  baseURL: opts.baseUrl,
  defaultHeaders: opts.defaultHeaders,
});
```

### 4. Model Router Integration

OpenRouter should work with Phase 10F role routing:

```json
{
  "models": {
    "roles": {
      "edit": { "provider": "openrouter", "model": "openai/gpt-5.2" },
      "review": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.6" },
      "summarize": { "provider": "openrouter", "model": "google/gemini-flash-1.5" }
    }
  }
}
```

`ProviderPool` already keys by `(provider, baseUrl)`, so OpenRouter should reuse the same
adapter instance for roles that share the OpenRouter backend.

Free-model role-routing example:

```json
{
  "models": {
    "roles": {
      "summarize": { "provider": "openrouter", "model": "openrouter/free" },
      "edit": { "provider": "openrouter", "model": "qwen/qwen3-coder:free" },
      "delegate": { "provider": "openrouter", "model": "poolside/laguna-m.1:free" },
      "review": { "provider": "openrouter", "model": "nvidia/nemotron-3-ultra-550b-a55b:free" }
    }
  }
}
```

### 4A. Free Coding Model Seed List

Snapshot date: 2026-06-22.

This list comes from OpenRouter's programming collection, free-model collection, model pages,
and public `/api/v1/models` catalog. It must be treated as a seed list for docs/examples, not
as a permanent hard-coded truth. Free availability and exact provider terms change often.

High-confidence free coding / coding-agent candidates:

| Model slug | Context | Notes |
| --- | ---: | --- |
| `qwen/qwen3-coder:free` | 1M | Agentic coding, tool use, and long-context repository reasoning. Strong default candidate for `edit` and delegated workers. |
| `openrouter/owl-alpha` | ~1.05M | Free OpenRouter model; described for code generation and agentic workflows. Free prompts/completions may be logged. |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | Free; appears in the programming ranking; useful candidate for review/planning. |
| `nex-agi/nex-n2-pro:free` | 262K | Free and programming-ranked, but OpenRouter marks it as going away on 2026-06-22. Keep as volatile. |
| `poolside/laguna-m.1:free` | 262K | Dedicated coding-agent model. Free usage may be used by the provider for training or improvement. |
| `poolside/laguna-xs.2:free` | 262K | Compact coding-agent model. Free usage may be used by the provider for training or improvement. |
| `cohere/north-mini-code:free` | 256K | Agentic coding / terminal-workflow model. Good cheap candidate for focused code tasks. |
| `google/gemma-4-31b-it:free` | 262K | Free; described as strong for coding, reasoning, and document understanding. |
| `openai/gpt-oss-120b:free` | 131K | Free; good general agentic/tool-use candidate, likely better for plan/review than large edits. |
| `openai/gpt-oss-20b:free` | 131K | Smaller free agentic/tool-use candidate for summaries and lightweight review. |
| `qwen/qwen3-next-80b-a3b-instruct:free` | 262K | Free catalog entry; general long-context helper. Lower coding-specific confidence than Qwen3 Coder. |
| `nvidia/nemotron-3-super-120b-a12b:free` | 1M | Free; page highlights benchmark strength including terminal/SWE-style tasks. |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 256K | Free; smaller NVIDIA candidate. Lower coding-specific confidence. |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | Free reasoning/multimodal variant. Lower coding-specific confidence. |
| `liquid/lfm-2.5-1.2b-thinking:free` | 32K | Free catalog entry surfaced by coding keyword filtering. Low confidence for serious code edits. |
| `nousresearch/hermes-3-llama-3.1-405b:free` | 131K | Free catalog entry surfaced by coding/tool keywords. Low confidence for code edits until smoke-tested. |

Routers:

- `openrouter/free` — free-model router. Good for smoke tests and non-critical tasks, but
  OpenRouter can change the underlying model, so do not use it for benchmark comparisons.
- `openrouter/pareto-code` — programming-focused router. Not a free-only route, but a useful
  follow-up for paid, coding-score-aware routing after Phase 10F exists.

Implementation requirement:

- Do not hard-code this table into runtime routing logic in v1.
- README may include the seed table and mark it as a dated snapshot.
- Tests may assert that example slugs parse and route correctly, but must not make live calls
  or require these models to remain available.
- Follow-up model-catalog sync can query `/api/v1/models`, filter free pricing, and cache a
  fresh `openrouter-free-coding.json` snapshot for user inspection.

### 5. Delegated Worker Env Forwarding

`buildWorkerEnv` must forward OpenRouter credentials only for OpenRouter:

- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_MODEL`
- optional attribution env vars

When a delegate model override selects `provider: "openrouter"`, child env should include:

```text
DEEPCODER_PROVIDER=openrouter
DEEPCODER_MODEL=<route.model>
DEEPCODER_BASE_URL=<route.baseUrl if set>
DEEPCODER_API_KEY=<OpenRouter key via env only>
```

Never put the key in argv, logs, plan files, or patch artifacts.

### 6. Pricing / Cost Telemetry

V1 does not need exact OpenRouter pricing because prices vary by model and provider.

Add conservative behavior:

- status/cost telemetry shows usage tokens,
- if provider is `openrouter` and model has no local pricing rule, cost is `unknown`,
- do not pretend OpenAI/Anthropic direct prices apply to OpenRouter slugs.

Follow-up:

- optional OpenRouter model metadata fetch/cache for live pricing.

### 7. Documentation

Update README provider table:

```text
openrouter | OpenRouter unified API; default base URL https://openrouter.ai/api/v1; key OPENROUTER_API_KEY
```

Add examples:

```bash
DEEPCODER_PROVIDER=openrouter \
OPENROUTER_API_KEY=... \
DEEPCODER_MODEL=openai/gpt-5.2 \
npm run dev -- "summarize this repo"
```

Role routing example:

```json
{
  "models": {
    "roles": {
      "edit": { "provider": "openrouter", "model": "deepseek/deepseek-v4-flash" },
      "plan": { "provider": "openrouter", "model": "anthropic/claude-opus-4.8" }
    }
  }
}
```

## Tests

### Config Tests

- `DEEPCODER_PROVIDER=openrouter` resolves provider `openrouter`.
- `OPENROUTER_API_KEY` satisfies the required key.
- `OPENROUTER_BASE_URL` is used when set.
- missing `OPENROUTER_API_KEY` fails clearly.
- `DEEPSEEK_API_KEY` does not satisfy `openrouter`.
- `OPENROUTER_API_KEY` does not satisfy `deepseek`, `gemini`, or `openai-compatible`.
- generic `DEEPCODER_API_KEY` still wins over provider-specific key.

### Provider Factory Tests

- `createProvider({ provider: "openrouter" })` returns `OpenAICompatibleProvider`.
- default base URL is `https://openrouter.ai/api/v1`.
- label in mapped errors is `OpenRouter`.
- optional attribution headers are passed to the OpenAI SDK constructor seam.
- API key is never included in thrown provider errors.

### Worker Env Tests

- OpenRouter key is forwarded only for OpenRouter delegated workers.
- delegate route override with `provider: "openrouter"` pins provider/model/baseUrl.
- key is env-only and never appears in command args.

### Router Tests

- file config can route `edit` or `review` to OpenRouter.
- `ProviderPool` caches OpenRouter adapter by `(openrouter, baseUrl)`.

### Documentation/Smoke

No live model required for merge.

Optional manual smoke:

```bash
DEEPCODER_PROVIDER=openrouter \
DEEPCODER_MODEL=openrouter/auto \
OPENROUTER_API_KEY=... \
npm run dev -- -p "Say ok"
```

## Safety

- Default provider remains unchanged.
- OpenRouter is selected only by explicit provider config/env.
- Keys are provider-prefixed and isolated.
- No secret values in logs/errors/tests.
- Attribution headers are optional and never include secrets.
- The provider changes only model API routing, not permissions/tools/sandbox behavior.

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- Provider-config adversarial tests pass.
- Provider factory tests pass.
- Delegated worker env tests pass.
- README documents provider usage.

## Implementation Order

1. Add OpenRouter constants and provider prefix in config/factory.
2. Extend `OpenAICompatibleProvider` with optional `defaultHeaders`.
3. Add OpenRouter factory case.
4. Add worker-env forwarding for OpenRouter.
5. Add config/factory/router/env tests.
6. Add README docs.
7. Optional live smoke with `OPENROUTER_API_KEY`.

## Follow-Ups

- Fetch/cache OpenRouter model catalog and prices.
- Route by OpenRouter provider preferences once policy syntax is designed.
- Add `/models openrouter search <query>` for model discovery.
- Add budget-aware OpenRouter routing to Phase 10F2.
