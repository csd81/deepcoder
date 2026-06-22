# Feature — DeepSeek optimization (default model, prefix caching, reasoning)

## Context

Deepcoder's DeepSeek provider works but doesn't fully leverage DeepSeek V4's capabilities. The default model alias will be deprecated in ~1 month, prefix caching isn't enabled (costing ~50% latency on repeated contexts), and the reasoning model's thinking budget isn't exposed. All three are small changes that together maximize DeepSeek performance and cost-efficiency.

## Design

### 1. Update default models (`src/config/config.ts`)

```ts
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  deepseek: "deepseek-v4-flash",           // was "deepseek-chat" (deprecated 2026-07-24)
  // …
};
```

Also update the reasoner default in the same file:

```ts
reasonerModel: process.env.DEEPSEEK_REASONER_MODEL
  ?? process.env.DEEPCODER_REASONER_MODEL
  ?? "deepseek-v4-pro",                    // was "deepseek-reasoner"
```

And the OpenRouter DeepSeek route:

```ts
openrouter: "deepseek/deepseek-v4-flash",  // was "deepseek/deepseek-chat"
```

### 2. Prefix caching (`src/providers/openaiCompatible.ts`)

DeepSeek's API supports prefix caching via the `x-*` header pattern. Add a `baseHeaders` option to `OpenAICompatibleOptions` and apply it in the DeepSeek constructor:

```ts
export interface OpenAICompatibleOptions {
  // … existing fields …
  /** Extra headers sent with every request (e.g. cache-control). */
  baseHeaders?: Record<string, string>;
}
```

In `createChatCompletion`, merge `baseHeaders` into the request:

```ts
const response = await this.client.chat.completions.create(
  { …body… },
  { headers: this.baseHeaders, signal },
);
```

In the DeepSeek provider:

```ts
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string }) {
    const baseHeaders: Record<string, string> = {};
    // Enable prefix caching (DeepSeek V4 supports this)
    // Sending the header tells DeepSeek to cache the prompt prefix across turns
    if (!process.env.DEEPSEEK_DISABLE_CACHE) {
      baseHeaders["x-deepseek-cache"] = "enable";
    }
    super({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
      label: "DeepSeek",
      baseHeaders,
    });
  }
}
```

The header is speculative — the exact header name depends on DeepSeek's API docs. If the header is wrong, it's silently ignored (no error). Add a env-var toggle (`DEEPSEEK_DISABLE_CACHE`) for safety.

### 3. Reasoning effort (`src/config/config.ts` + DeepSeek provider)

Add `reasoningEffort` to the chain of env vars → config → provider:

```ts
// In config.ts:
reasoningEffort: (process.env.DEEPSEEK_REASONING_EFFORT
  ?? process.env.DEEPCODER_REASONING_EFFORT
  ?? "medium") as "low" | "medium" | "high",
```

Thread it through the provider factory to `OpenAICompatibleOptions`:

```ts
if (provider === "deepseek" && config.reasoningEffort) {
  opts.reasoningEffort = config.reasoningEffort;
}
```

In `openaiCompatible.ts`, add an optional `reasoningEffort` field to `OpenAICompatibleOptions`. When set, append the `reasoning` block to the chat completion body (DeepSeek V4 Pro accepts this):

```ts
const body: Record<string, unknown> = {
  model: input.model,
  messages,
  tools: tools.length ? tools : undefined,
};
if (this.reasoningEffort && input.model.includes("deepseek-v4-pro")) {
  body.reasoning = { effort: this.reasoningEffort };
}
```

This lets users trade depth for speed: `low` for quick edits, `high` for complex refactors.

## Files

- **Edit:** `src/config/config.ts` (default models, reasoner model, reasoning effort), `src/providers/deepseek.ts` (prefix cache header, reasoning effort), `src/providers/openaiCompatible.ts` (baseHeaders support, reasoning effort in body).

## Tests

- Default model updated: `PROVIDER_DEFAULT_MODELS.deepseek === "deepseek-v4-flash"`.
- Cache header sent: DeepSeek provider request includes `x-deepseek-cache: enable` unless `DEEPSEEK_DISABLE_CACHE` is set.
- Reasoning effort: when `reasoningEffort` is set and model is `deepseek-v4-pro`, the request body includes `reasoning: { effort: "high" }`.
- Reasoning effort: when model is NOT `deepseek-v4-pro` (e.g. `deepseek-v4-flash`), the reasoning block is omitted.
- Reasoning effort: no env var set → defaults to `"medium"`, omitted from body (let API use its default).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: run deepcoder with default DeepSeek provider → uses `deepseek-v4-flash` (check log or `/status`).
3. Set `DEEPSEEK_REASONING_EFFORT=high DEEPCODER_MODEL=deepseek-v4-pro` → reasoning block sent.
4. Prefix caching: observe request headers in proxy logs (or trust the header is sent).

## Safety

- Cache header is opt-out via `DEEPSEEK_DISABLE_CACHE` — safe default.
- Reasoning effort is omitted for models that don't support it (Flash, not Pro).
- Model alias change is backward-compatible: `deepseek-v4-flash` is the live production name; `deepseek-chat` still routes to the same engine but will be deprecated.
