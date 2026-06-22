# Feature — Responses API built-in tools (`web_search`, `file_search`, `code_interpreter`)

## Context

Deepcoder has an OpenAI Responses API provider (`src/providers/openaiResponses.ts`) but it only supports function calling — none of the Responses API's built-in tools (`web_search`, `file_search`, `code_interpreter`). The existing web search feature (`src/web/`) is implemented in-house (Brave search provider, custom fetch logic). The Responses API could offload these to OpenAI's server-side implementations, reducing code and potentially improving quality.

Pi has a more complete Responses implementation with built-in tools wired. Codex CLI uses the Responses API natively (it's OpenAI's tool).

## Model

- When using the OpenAI Responses provider (`DEEPCODER_PROVIDER=openai-responses`), the agent can use built-in Responses API tools:
  - `web_search` — model-initiated web search, handled server-side
  - `code_interpreter` — sandboxed Python execution for data analysis, math, etc.
- These tools are registered alongside deepcoder's native tools but marked as `"responses_builtin"` — the provider serializes them as Responses API tool configs instead of function calls.
- Non-Responses providers ignore these (fall back to deepcoder's native implementations).
- `file_search` is deferred (requires OpenAI-hosted files, less relevant for a local CLI).

## Design

### 1. Tool type extension (`src/providers/types.ts`)

```ts
export type ToolKind = "read-only" | "mutate" | "execute" | "session" | "responses_builtin";
```

Add a `responsesBuiltin?: { name: string; config: Record<string, unknown> }` field to `ToolSchema`:

```ts
export interface ToolSchema {
  name: string;
  description: string;
  parameters?: unknown;
  kind?: ToolKind;
  /** When set, this tool is a Responses API built-in, not a function call. */
  responsesBuiltin?: { name: string; config: Record<string, unknown> };
}
```

### 2. Tool definitions (`src/tools/responsesTools.ts`)

```ts
export const responsesWebSearchTool: Tool = {
  name: "web_search",
  kind: "responses_builtin",
  description: "Search the web for current information. Useful for recent events, documentation, APIs.",
  schema: { /* user-facing schema for non-Responses fallback */ },
  responsesBuiltin: {
    name: "web_search",
    config: { user_location: { type: "approximate" } },
  },
};

export const responsesCodeInterpreterTool: Tool = {
  name: "code_interpreter",
  kind: "responses_builtin",
  description: "Execute Python code in a sandboxed environment. Useful for data analysis, math, visualization.",
  responsesBuiltin: {
    name: "code_interpreter",
    config: {},
  },
};
```

These tools are registered only for the Responses provider — filtered out for other providers.

### 3. Provider serialization (`src/providers/openaiResponses.ts`)

When building the Responses request body, separate tools into function calls vs built-in tools:

```ts
function toResponsesTools(tools: ToolSchema[]): { functions: ResponsesInputItem[]; builtins: Record<string, unknown>[] } {
  const functions: ResponsesInputItem[] = [];
  const builtins: Record<string, unknown>[] = [];

  for (const t of tools) {
    if (t.responsesBuiltin) {
      builtins.push({ type: t.responsesBuiltin.name, ...t.responsesBuiltin.config });
    } else {
      functions.push({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
    }
  }

  return { functions, builtins };
}
```

### 4. Agent loop changes (`src/agent/agentLoop.ts`)

The agent loop already filters tools based on the provider. When using the Responses provider, add the built-in tools to the tool list.

### 5. Streaming

SHOULD: Add streaming support (`streamChat`) to the Responses provider for faster feedback:

```ts
async streamChat(input: ChatRequest): Promise<AsyncIterable<ModelEvent>> {
  // Use OpenAI SDK's streaming responses API
  const stream = await client.responses.create({ ...body, stream: true });
  // Yield ModelEvent.token deltas
}
```

## Files

- **Edit:** `src/providers/openaiResponses.ts` (add built-in tool serialization, streaming), `src/providers/types.ts` (add `responsesBuiltin` to `ToolSchema`, `"responses_builtin"` kind), `src/tools/responsesTools.ts` (new), `src/runtime/sessionFactory.ts` (register built-in tools for Responses provider).

## Tests

- `toResponsesTools` separates function tools from built-in tools.
- `toResponsesTools` with a mix of both produces correct request body.
- A non-Responses provider ignores `responsesBuiltin` tools (not registered).
- Streaming: `streamChat` yields token events.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: `DEEPCODER_PROVIDER=openai-responses deepcoder "search the web for latest TypeScript news"` → model uses built-in `web_search`.
3. `DEEPCODER_PROVIDER=openai-responses deepcoder "calculate 2^1000"` → model uses `code_interpreter`.

## Safety

- `responses_builtin` tools are read-only (`web_search`) or sandboxed server-side (`code_interpreter`). No new local execution surface.
- Only registered for the Responses provider — other providers never see them.
- Streaming is additive — non-streaming fallback always works.
