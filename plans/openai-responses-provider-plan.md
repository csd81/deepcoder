# OpenAI Responses-API provider (`openai-responses`) — design

Date: 2026-06-20
Status: approved (pending spec review)

## Goal

Add a new model provider that talks to OpenAI's **Responses API** (`/v1/responses`)
so deepcoder can use models that are *only* available there — notably the codex
family (`gpt-5.3-codex`, `gpt-5-codex`, …), which return 404 on
`/v1/chat/completions` at any temperature. The existing `openai-compatible`
(chat-completions) provider stays as-is; this is a sibling, selected by provider
name.

v1 is **non-streaming `chat()` only**. The agent loop falls back to `chat()` when
a provider omits `streamChat`, so codex/gpt-5.x work end-to-end (delegated workers
and interactive) — just without live token-by-token output. `streamChat` is
deferred (see Out of scope).

## Why a separate provider (not a mode on the existing one)

The Responses wire format differs enough from chat-completions (`input` items vs
`messages`, flat function tools, `function_call`/`function_call_output`
round-tripping by `call_id`, `reasoning` blocks, `output[]` vs `choices[]`) that
folding both into one class would muddy it. A separate `OpenAIResponsesProvider`
keeps each provider single-purpose; shared helpers are reused, not duplicated.

## Component 1 — `src/providers/openaiResponses.ts`

`class OpenAIResponsesProvider implements ModelProvider` exposing **`chat()`**
only. Uses the installed `openai@^4.67.0` SDK's `client.responses.create(...)`
(verified present), so wire serialization is the SDK's job, not ours.

```ts
export interface OpenAIResponsesOptions {
  apiKey: string;
  baseUrl: string;
  label: string;                      // for error messages
  reasoningEffort?: "low" | "medium" | "high";  // default "medium"
  /** Test seam: inject a fake responses.create. Defaults to the real SDK. */
  createResponse?: (body: unknown, opts: { signal?: AbortSignal }) => Promise<ResponsesResult>;
}
```

`chat(input)` flow:
1. `{ instructions, input } = toResponsesInput(input.messages)`.
2. `tools = toResponsesTools(input.tools)`.
3. Build body: `{ model: input.model, instructions, input, tools (if any),
   tool_choice: tools? "auto" : undefined, reasoning: { effort } }`.
   **No `temperature`** (codex/reasoning models reject non-default).
4. `res = await createResponse(body, { signal })` — wrapped in try/catch →
   `mapProviderError`.
5. `return parseResponsesOutput(res)`.

## Component 2 — pure mapping functions (the real work; unit-tested directly)

Exported from the same module, no I/O:

- **`toResponsesInput(messages): { instructions: string; input: ResponsesInputItem[] }`**
  - system messages → concatenated into `instructions` (newline-joined);
  - user → `{ role: "user", content: text }`;
  - assistant text → `{ role: "assistant", content: text }`;
  - assistant `toolCalls` → one `{ type: "function_call", call_id: id, name,
    arguments: JSON.stringify(args) }` per call;
  - tool result (`role: "tool"`) → `{ type: "function_call_output",
    call_id: toolCallId, output: content }`.
- **`toResponsesTools(tools): ResponsesTool[]`** → `{ type: "function", name,
  description, parameters }` (flat — NOT nested under `function` like
  chat-completions).
- **`parseResponsesOutput(res): ChatResponse`** — walk `res.output[]`:
  - `message` items → concatenate their `output_text` content → `text`
    (fall back to `res.output_text` if present);
  - `function_call` items → `toolCalls` (`id = call_id`, `name`,
    `arguments = safeParseArgs(item.arguments)`);
  - `reasoning` items → ignored (not surfaced as text).

`call_id` is the contract that ties a model-issued `function_call` to the
`function_call_output` we send back next turn; the round-trip must preserve it
exactly.

## Component 3 — wiring

- **factory.ts**: `case "openai-responses": return new OpenAIResponsesProvider({
  apiKey, baseUrl, label: "OpenAI Responses", reasoningEffort });`
- **config.ts**:
  - `PROVIDER_DEFAULT_MODELS["openai-responses"] = "gpt-5.3-codex";`
  - `PROVIDER_ENV_PREFIX["openai-responses"] = "OPENAI";` (reuses `OPENAI_API_KEY`
    / `OPENAI_BASE_URL` / `OPENAI_MODEL`);
  - resolve `reasoningEffort` from `DEEPCODER_REASONING_EFFORT`
    (`low|medium|high`, default `medium`); add `reasoningEffort` to `Config` and
    pass it through `createProvider`;
  - `KNOWN_PROVIDERS` includes it automatically (derived from
    `PROVIDER_DEFAULT_MODELS`).
- **Reuse** `mapProviderError`, `redactSecrets`, `safeParseArgs`, `ProviderError`
  from `openaiCompatible.ts` (already exported). No duplication.

The base URL: `openai-responses` resolves `baseUrl` from `OPENAI_BASE_URL` (or the
openai-compatible default `https://api.openai.com/v1`), same as today.

## Error handling

All SDK calls are wrapped; errors go through the existing `mapProviderError`
(Responses errors carry `.status` like chat-completions, so 401/429/400/404 map
cleanly). The API key never appears in any surfaced error (`redactSecrets`).

## Testing (no live model in the gate)

`test/adversarial/openai-responses.test.ts`:
- **Mapping (pure):** system→instructions; user/assistant text items; an
  assistant tool-call + its tool result round-trip preserving `call_id`; tools
  are flat-shaped; `parseResponsesOutput` extracts text + tool calls and ignores
  reasoning items; malformed/garbage tool arguments → `{}` (via `safeParseArgs`).
- **`chat()` with an injected fake `createResponse`:** asserts the request body
  is the mapped shape (instructions/input/tools/reasoning, **no temperature**) and
  the returned `ChatResponse` is correct — no network.
- **Errors:** a fake throwing `{ status: 404 }` → `ProviderError` mentioning the
  model; a key embedded in an error message is redacted.

**Separate live smoke (NOT in the gate, explicit):** one real `chat()` against
`gpt-5.3-codex` confirming a 200 and that a tool call comes back — key from env,
never printed/logged/committed.

## Verification / acceptance

- `npm run test:phase` green (typecheck + unit + new adversarial), **no live model**.
- A delegated worker can run with `DEEPCODER_PROVIDER=openai-responses` +
  `DEEPCODER_MODEL=gpt-5.3-codex` (separate, explicit live run — not part of the gate).

## Approved defaults

- Reasoning effort default: **`medium`** (env `DEEPCODER_REASONING_EFFORT`).
- Default model for the provider: **`gpt-5.3-codex`**.
- **Temperature omitted entirely** in v1.

## Out of scope (v1)

- `streamChat` for the Responses provider (loop falls back to `chat()`).
- The Responses `store` / `previous_response_id` conversation-state feature
  (deepcoder resends full message history each turn, which is fine).
- Non-OpenAI Responses-style endpoints.
- Any change to the existing `openai-compatible` / DeepSeek / other providers.
