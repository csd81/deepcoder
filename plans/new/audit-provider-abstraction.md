# Audit: Provider abstraction (DeepSeek-only)

## Scope
`src/providers/deepseek.ts`, `src/providers/openaiCompatible.ts` (HTTP base), `src/providers/factory.ts` (single case).

## Current state
After the DeepSeek-only migration, the provider layer is:
- **DeepSeek provider** (`deepseek.ts`): thin wrapper over `OpenAICompatibleProvider` with DeepSeek defaults
- **OpenAI-compatible base** (`openaiCompatible.ts`): HTTP client, streaming, error mapping — shared between DeepSeek and any future OpenAI-compatible backends
- **Factory** (`factory.ts`): single case for `deepseek`

## What to verify

### DeepSeek-specific optimization
- `temperature: 0` — set for deterministic output. Does DeepSeek V4 Flash actually respect `temperature: 0`? (some models round it to the nearest supported value)
- `max_tokens` — should be set to 16384 for Flash (8K output limit) and 16384 for Pro (16K). Verify the actual limits from DeepSeek's API docs.
- `reasoning.effort` — only valid for Pro, should be omitted for Flash. Verify the provider correctly distinguishes them.
- Prefix caching headers (`x-deepseek-cache`) — being sent? Verified working?

### Streaming
- `streamChat` is inherited from `OpenAICompatibleProvider`. Does DeepSeek's streaming API match OpenAI's wire format exactly? (same chunk structure, same event ordering)
- DeepSeek streaming can include `reasoning_content` in chunks for Pro model. Does the provider handle or discard this correctly?
- Stream fallback (when streaming errors, fall back to `chat()`) — is this wired? (from error recovery plan)

### Error mapping
- `mapProviderError` maps HTTP status codes. DeepSeek-specific statuses:
  - 429 — rate limit. Does DeepSeek return `Retry-After` header? Should respect it.
  - 402 — insufficient balance. Should be a clear message, not a generic "request failed".
  - 503 — model overloaded. Should suggest retrying with Flash instead of Pro.
- Are error messages actionable? Instead of "DeepSeek request failed: 402", should be "DeepSeek API returned 402 — insufficient balance. Check your DeepSeek account credits."

### Timeout configuration
- Default request timeout: inherited from OpenAI SDK (10 minutes). Should be lower for DeepSeek (30s for Flash, 60s for Pro).
- Stream timeout: if no chunk arrives for 30s, should abort. Currently none.
- Connection timeout: if DNS/connect takes >5s, should abort. Currently none.

### Removed complexity
- Previously 6 provider backends with different wire formats. Now 1.
- Previously model router for per-role provider selection. Now 1 model string.
- Previously provider env-var resolution (`DEEPSEEK_*` vs `ANTHROPIC_*` vs `GOOGLE_*`). Now just `DEEPSEEK_*`.
- All removed code should be cleanly deleted, not commented out.

## Deliverables
- DeepSeek API parameter matrix (which params work on Flash vs Pro)
- Streaming wire-format verification (capture real DeepSeek streaming chunks, compare to expected)
- Timeout profile (how long do real DeepSeek calls take? P50/P95/P99)
- Error message audit (are all DeepSeek error status codes mapped to actionable messages?)
- Clean deletion checklist (verify no dead code or stale imports from removed providers remain)
