# Feature — Error recovery (graceful handling of API errors)

## Context

Deepcoder's agent loop wraps each tool execution in a try-catch (line 204-212), turning tool failures into model-visible error messages. But the **provider call** (`getResponse` at line 107) is NOT wrapped — if the API returns a rate limit, auth error, or network timeout, the raw `ProviderError` propagates up and crashes the whole turn with an unhelpful message. The user sees something like `DeepSeek request failed: 429 Too Many Requests` and the session is aborted.

Three gaps exist:
1. Provider errors during `getResponse` crash the turn instead of being recoverable
2. Rate limits (429) have no retry logic — opencode retries with backoff
3. Stream errors (timeout, connection reset) crash instead of falling back to non-streaming

## Design

### 1. Wrap `getResponse` with error recovery (`src/agent/agentLoop.ts`)

```ts
const response = await getResponseWithRetry(deps, messages);
```

```ts
async function getResponseWithRetry(deps: AgentDeps, sent: AgentMessage[]): Promise<ChatResponse> {
  const maxRetries = 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getResponse(deps, sent);
    } catch (err) {
      lastError = err as Error;

      // 429 → retry with exponential backoff
      if (isRateLimit(err)) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 10_000);
        deps.onNotice?.(`Rate limited. Retrying in ${wait}ms…`);
        await sleep(wait);
        continue;
      }

      // Auth errors (401) — no retry, fatal
      if (isAuthError(err)) {
        deps.onNotice?.(`API key rejected. Check your credentials.`);
        throw err;
      }

      // Model errors (404, 400) — no retry, fatal
      if (isModelError(err)) {
        deps.onNotice?.(`Model "${deps.model}" unavailable. Check the model name.`);
        throw err;
      }

      // Transient errors (timeout, 5xx) — retry once
      if (attempt < maxRetries) {
        deps.onNotice?.(`API error, retrying… (${attempt + 1}/${maxRetries})`);
        continue;
      }
    }
  }

  // All retries exhausted — return an empty response instead of crashing
  deps.onNotice?.(`Provider unreachable after ${maxRetries + 1} attempts: ${lastError?.message}.`);
  return { text: "", toolCalls: [], usage: undefined };
}
```

### 2. Error classifiers (`src/agent/agentLoop.ts` or shared utils)

```ts
function isRateLimit(err: Error): boolean {
  return err.message.includes("429") || err.message.includes("rate limit");
}

function isAuthError(err: Error): boolean {
  return err.message.includes("401") || err.message.includes("API key");
}

function isModelError(err: Error): boolean {
  return err.message.includes("404") || err.message.includes("400");
}
```

### 3. Stream error recovery (`consumeStream`)

When a stream yields `{ type: "error" }`, instead of throwing (line 329), fall back to non-streaming `chat()`:

```ts
async function consumeStream(
  stream: AsyncIterable<ModelEvent>,
  deps: AgentDeps,
  req: ChatRequest,
): Promise<ChatResponse> {
  try {
    // … existing stream consumption …
  } catch (err) {
    // Stream failed — fall back to non-streaming
    deps.onNotice?.("Stream interrupted, falling back to non-streaming…");
    return deps.provider.chat(req);
  }
}
```

This requires passing `deps` and `req` to `consumeStream`.

### 4. Provider-level retry hints

Add optional `ProviderCapabilities` to the provider interface so the agent loop knows whether retries are useful:

```ts
export interface ProviderCapabilities {
  retryOnStatus?: number[];  // e.g. [429, 502, 503]
}
```

Default for OpenAI-compatible: `[429]`.

### 5. User-visible crash reduction

After these changes, the only uncaught errors should be:
- Auth failures (bad API key) — clear message, no crash
- Model not found — clear message, no crash  
- Input validation errors (shouldn't happen post-parse) — crash, but those are our bugs

Everything else is recovered silently or with a visible notice.

## Files

- **Edit:** `src/agent/agentLoop.ts` (wrap `getResponse`, retry logic, stream fallback).

## Tests

- `getResponseWithRetry` on 429 → waits and retries, succeeds on retry 2.
- `getResponseWithRetry` on persistent 429 → returns empty response after exhausting retries, does NOT throw.
- `getResponseWithRetry` on 401 → throws immediately (no retry).
- `getResponseWithRetry` on transient error (timeout) → retries once.
- Stream error → falls back to `chat()`, returns non-stream response.
- All retry paths call `deps.onNotice` with informative messages.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Simulate a 429 response from the provider → agent shows "Rate limited. Retrying…", recovers.
3. Simulate a stream failure → agent falls back to non-streaming, completes the turn.
4. Real test: use a model that doesn't exist (404) → agent shows "Model unavailable. Check the model name.", doesn't crash.

## Safety

- All changes are in the error recovery layer — no effect on successful turns.
- Retries have bounded attempts (2) and exponential backoff (max 10s).
- Stream fallback is a synchronous `chat()` call — no new timeout surface.
- Empty response on exhaustion gives the model nothing to work with, but the session survives.

## Review & Feedback (June 22, 2026)

The plan has been reviewed with the following critical findings and recommendations:

### 1. Exponential Backoff & Sleep Safety
* **Issue:** Call to `sleep` in Node.js/TypeScript requires helper implementation or importing.
* **Risk:** A standard `sleep` promise keeps the event loop blocked even if the user aborts (`Ctrl+C`), ignoring the abort signal.
* **Recommendation:** Implement a signal-aware sleep helper inside the loop.

### 2. Empty Response Fallback (High Risk)
* **Issue:** Returning `{ text: "", toolCalls: [], usage: undefined }` on retry exhaustion triggers the termination condition in `runAgentLoop` (zero tool calls).
* **Risk:** The CLI will treat this as a successful turn with an empty assistant message, exiting silently and leaving the user with a misleading successful exit when the API was actually unreachable.
* **Recommendation:** Do not return an empty response. Re-throw the original `ProviderError` (or a structured variant) so the CLI can catch and report it properly.

### 3. Case-Insensitive Message Matching
* **Issue:** Message-based classification should be case-insensitive to ensure robust detection across different API versions and SDK changes (e.g. `rate limit` vs `Rate Limit`).

### 4. Stream Fallback Notice
* **Recommendation:** Ensure that the TUI/REPL shows a clear notice when a stream connection reset triggers the fallback to non-streaming, to explain the duplicate output that might print.

