# Plan — DeepSeek-only: strip multi-provider breadth + optimize the one family

## The bet

DeepSeek V4 (Flash/Pro) is good enough for ~90% of coding tasks at ~10% of the
cost. The maintenance burden of alternate providers isn't worth it. So: collapse to
**one model family** and tune everything — prompt, temperature, caching, reasoning,
context budget — specifically for it. Every optimization then lands for 100% of
users, and "works on DeepSeek but not on Anthropic" regressions become impossible.

This is **one combined plan**: strip the multi-provider layer AND apply the DeepSeek
optimizations together.

## What "DeepSeek-only" actually means (two corrections to the naive draft)

Grounded in the real code (`src/providers/factory.ts`, `src/models/router.ts`) — the
prior draft got both of these wrong:

1. **`openaiCompatible.ts` STAYS — DeepSeek *is* that provider.** `deepseek.ts` is a
   thin preset (`class DeepSeekProvider extends OpenAICompatibleProvider`). Deleting
   the engine breaks DeepSeek. The alt-vendor "providers" (`ollama`/`qwen`/`gemini`)
   are **not separate files** — they are just `case`s in the factory that construct
   `OpenAICompatibleProvider` with a different base URL. Only `anthropic.ts` and
   `openaiResponses.ts` are real separate adapter files.
2. **The role-routing layer STAYS — it is model-based, not provider-based.** Every
   role in `router.ts:resolveDefault` resolves `provider: this.config.provider`
   (always DeepSeek) and varies only the *model* (`config.model` for edit,
   `reasonerModel ?? model` for plan, `subagentModel` for review/…). So `router.ts`,
   `taskRouter.ts`, `providerPool.ts`, `sessionOverrides.ts`, `models/types.ts` all
   KEEP — they already work with one provider + many models
   (`deepseek-chat`/`deepseek-reasoner`).

**Kept transports:** `deepseek` (direct) + `openai-compatible` (zero-maintenance
escape hatch — same engine — for a local/proxy/self-hosted DeepSeek endpoint).
**OpenRouter is REMOVED** (user decision 2026-06-22 — reverses the earlier
"keep as fallback"). Anyone wanting a custom endpoint sets `DEEPCODER_BASE_URL`
with `DEEPCODER_PROVIDER=openai-compatible`.

## Workstream A — Strip the alternate providers

### Remove (whole files)
- `src/providers/anthropic.ts`, `src/providers/openaiResponses.ts`
- `test/adversarial/anthropic.test.ts`, `test/adversarial/openai-responses.test.ts`,
  `test/adversarial/compaction-gemini.test.ts`, `test/adversarial/openrouter-provider.test.ts`

### Update
- **`src/providers/factory.ts`** — drop the `ollama`, `qwen`, `gemini`, `anthropic`,
  `openai-responses`, **and `openrouter`** cases + their default-base-URL consts +
  the `geminiWireModelName` helper + `OPENROUTER_DEFAULT_BASE_URL` +
  `openRouterAttributionHeaders`. Keep only `deepseek` + `openai-compatible`. Fix the
  `default:` error message.
- **`src/config/config.ts`** — trim `PROVIDER_DEFAULT_MODELS` (~333-347) and
  `PROVIDER_ENV_PREFIX` (~358-367) to `deepseek` + `openai-compatible` (drop
  `openrouter` too); fix the `KNOWN_PROVIDERS` error message (~620); remove the
  `provider === "ollama"` empty-key special-case (~633).
- **`src/providers/pricing.ts`** — remove `gemini`/`anthropic`/`ollama` entries
  (~45-54); keep `deepseek` + `openai-compatible`.
- **`src/config/debugConfig.ts`** — remove alt-provider prefix entries (~90-99).
- **`src/cli/repl.ts`** — `webAware` is triggered only by `config.provider ===
  "openrouter"` (~306). With OpenRouter gone, set `webAware: false` (no kept provider
  is web-aware). The `src/web/searchCapableRouting.ts` module STAYS (it serves the
  web-search citation feature generally) — only the openrouter trigger is dropped.
- **`scripts/delegate.sh`** — remove the `openrouter` provider case (keep `deepseek`,
  `deepseek-pro`).
- **Tests (update, not delete):** `providers.test.ts` (drop ollama/qwen/gemini/
  anthropic + `geminiWireModelName` cases), `provider-config.test.ts` (drop gemini/
  ollama/openai-responses + openrouter cases), `model-router.test.ts:61`
  (anthropic → deepseek), `debug-config.test.ts`, `context-budget-default.test.ts`.
- **Docs:** `docs/delegation-workflow.md` (drop Gemini + OpenRouter examples).

### Explicitly OUT of scope for the strip
- **Semantic embeddings** (`src/semantic/ollamaEmbeddingProvider.ts`,
  `semantic/provider.ts`) — a *different subsystem* (local embedding for the semantic
  index), not the chat provider. Leave it untouched.

## Workstream B — Optimize the DeepSeek family

(folds in / supersedes `plans/new/feat-deepseek-optimize-plan.md`)

1. **Default model alias** (`config.ts`): `deepseek: "deepseek-chat" →
   "deepseek-v4-flash"`; reasoner `→ "deepseek-v4-pro"`; openrouter `→
   "deepseek/deepseek-v4-flash"`. **De-risked:** the 5 delegated workers just ran
   live against `api.deepseek.com` with these exact names — they are real.
2. **Temperature 0 for determinism** — set the DeepSeek default temperature to `0`
   via the factory → `OpenAICompatibleOptions` (`temperatureField` already emits
   `{temperature:0}`). Per-call override still wins.
3. **Prefix caching** (`openaiCompatible.ts`) — add a `baseHeaders` passthrough.
   **⚠ VERIFY FIRST:** DeepSeek context caching is largely *automatic* server-side
   (cache-hit pricing without a header). The real lever is **prompt-prefix stability**
   (system prompt + tool schemas first, volatile content last) + **surfacing cache-hit
   tokens** from the usage block — NOT a speculative `x-deepseek-cache` header. Confirm
   against live API docs before shipping a header; gate any header behind
   `DEEPSEEK_DISABLE_CACHE`.
4. **Reasoning effort** (Pro only) — optional `reasoningEffort` → `body.reasoning =
   { effort }` only when `model.includes("deepseek-v4-pro")`; omitted for Flash.
   **✅ VERIFIED 2026-06-22 (live smoke):** `deepseek-v4-pro` accepts
   `reasoning: { effort: "high" }` with no 400; Flash never receives it. (Accepted
   without error — a trivial prompt can't prove it deepens reasoning, but it is safe.)
5. **Context budget** — already `deepseek → 1_000_000`, `compactAt 0.95`. Confirm it
   still resolves after the config trim; no change expected.

## Execution (in-house subagents — risky, NOT DeepSeek-delegated)

Per the in-house-vs-DeepSeek rule (provider/config/contract changes are risky).
Disjoint file groups; I integrate + run the full gate:
- **G1 strip-core:** `factory.ts`, delete `anthropic.ts`/`openaiResponses.ts`,
  `pricing.ts`, `debugConfig.ts`.
- **G2 config:** `config.ts` provider maps/prefixes/error/key-check.
- **G3 tests:** delete 3 dead test files; update the 5 shared test files.
- **G4 optimize:** model defaults + temperature-0 + `reasoningEffort` config in
  `config.ts`; `baseHeaders` + reasoning body in `openaiCompatible.ts`; `deepseek.ts`
  preset. (G2 & G4 both touch `config.ts` → I land G4's config edits myself or
  serialize to avoid conflict.)

**Wiring mandatory:** every change leaves the runtime coherent in the same pass —
`createProvider` compiles with the reduced union, defaults resolve, no dangling
imports. Anchor checks: zero surviving imports of a deleted provider;
`KNOWN_PROVIDERS` set === factory `case` set === `PROVIDER_ENV_PREFIX` keys.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` fully green.
2. Grep gate: zero live references to removed providers in `src/` (anthropic / gemini
   / qwen / openai-responses / openrouter; ollama only outside the semantic embedding
   subsystem).
3. `KNOWN_PROVIDERS` === factory cases === `PROVIDER_ENV_PREFIX` keys.
4. Live smoke (key in env, never logged): one `deepseek-v4-flash` and one
   `deepseek-v4-pro` turn succeed; if a cache/reasoning param was added, confirm the
   API doesn't 400 on it (else revert that param).

## Decisions (resolved 2026-06-22)

1. **`openai-compatible`** — KEEP as the escape hatch.
2. **`openrouter`** — REMOVE entirely (reverses earlier "keep as fallback").
3. **README / identity** — flip "model-agnostic" → "DeepSeek-tuned" as a non-blocking
   docs follow-up.

## Out of scope (deliberate)
- Removing the semantic-index embedding providers (separate subsystem).
- DeepSeek-specific tokenizer vs generic counting (later).
- Streaming-vs-non-streaming latency tuning (later).
</content>
