# Feature — Token usage optimization (v2, rewritten)

> **This plan replaces an earlier draft that was technically unsound.** The old
> draft's centerpiece — "send tool schemas once, omit the `tools` param on later
> turns" — would break the agent (the OpenAI-compatible API needs `tools` every
> turn to enable function-calling) and chased savings that DeepSeek's prefix
> cache already delivers. See **Appendix A** for the full post-mortem before
> re-proposing any of it.

## Implementation status (2026-06-23)

- **Item 1 — token-efficiency report: DONE.** Added pure `tokenEfficiency(usage,
  cost)` in `pricing.ts` (cache-hit rate, fresh/cached/output USD split, dominant
  cost class) + wired into the `/cost` view (`slashReadOnlyResults.ts`). TDD,
  5 new unit tests.
- **Item 3 — prefix-cache stability guard: DONE.** `buildSystemPrompt` is already
  a pure function of its inputs; added a regression guard
  (`system-prompt-cache-stability.test.ts`) pinning byte-identical output and
  scanning for volatile (timestamp/date/clock) leaks.
- **Item 6 — tighter compaction summary: DONE (partial-as-designed).** Resolved
  todos were *already* dropped; the genuine residual was the unbounded
  `## Files changed` list — now capped at 40 entries via `boundLines` with an
  explicit marker. (Dropping *pending* todos and the "single paragraph" idea were
  rejected: they'd lose planned work and break `extractTaskFromSummary`.)
- **Item 4 — tool-result caps: ALREADY SATISFIED, no change.** Every result
  passes `capToolResult` (100 KB backstop, `agentLoop.ts:580`); high-volume tools
  self-bound with markers; a one-shot read-volume nudge already exists
  (`agentLoop.ts:148-153`). Guessing tighter caps without item-1 data would
  violate this plan's own guidance.
- **Items 2 & 5 — prompt terseness / efficiency nudges: NOT CHANGED.** The
  DeepSeek system-prompt section already enforces conciseness, parallel batching,
  and investigation discipline. These are eval-gated behavior changes; making
  unvalidated wording edits risks the false-affordance failure the plan itself
  warns about. Left for an eval-backed pass.

Verification: `npm run test:phase` green (1861/1861, typecheck clean).

## Context

deepcoder is **DeepSeek-only** (`src/providers/factory.ts`: `deepseek` /
`openai-compatible` both ride `OpenAICompatibleProvider`; `faux` is test-only).
DeepSeek bills three token classes very differently (`src/providers/pricing.ts`,
`deepseek-v4-flash`):

| Token class | $/M | Relative |
|---|---|---|
| **Output** (completion) | **1.10** | **40×** |
| Fresh input (cache miss) | 0.27 | 10× |
| Cached input (prefix cache hit) | 0.027 | 1× |

The entire optimization thesis follows from this table: **token *type* dominates
token *count*.** One output token costs as much as 40 cached-input tokens. A
stable, cache-hit prompt prefix is already nearly free. So we optimize in strict
$-impact order: (1) measure, (2) cut output, (3) protect the cache, (4) bound
fresh input. Latency tracks the same order — cached prefix tokens are fast to
process; output tokens and extra round-trips are what users wait on.

## Current state (verified against the code)

- **Tool schemas are sent every turn** (`agentLoop.ts:520` `tools:
  deps.registry.schemas()`). Because they are byte-identical each turn, they sit
  in the cached prefix and bill at 0.027/M. They are *not* a meaningful waste.
- **Prompt prefix is already mostly stable.** `systemPrompt.ts` embeds only
  per-session-stable values (workspace root, approval mode) — no timestamps or
  per-turn state. Volatile context (todos, JIT path-local instructions,
  delegation hints) is **appended at the end** via `withEphemeralContext`
  (`agentLoop.ts:399`), which is the cache-friendly placement.
- **History is append-only.** `sanitizeForProvider` operates on a *copy* and is a
  no-op in steady state (only drops dangling tool refs at compaction boundaries).
- **Cache-hit tokens are captured** (`usage.ts:26` reads
  `prompt_cache_hit_tokens`) but **never surfaced** as a hit-rate metric.
- **Output is bounded** with explicit markers: line-based caps in
  `outputBound.ts`, a global byte cap in `agentLoop.ts:111-126`, per-stream caps
  in `runBash.ts`. There is **no "unbounded" tool result** (the old draft was
  wrong about this).
- **Compaction** triggers at `compactAt` (default **0.8**, env
  `DEEPCODER_COMPACT_AT`, `config.ts:786`); it rewrites history in place.

## Work items (ordered by $ impact)

### 1. Measure before optimizing (foundation — do this first)

We capture `cachedPromptTokens` but never report cache-hit rate or the
output/input split, so today we'd be optimizing blind. Add a per-session token
report.

- **Surface** at session end (and behind `/cost` or the statusline): output
  tokens, fresh-input tokens, cached-input tokens, **cache-hit rate**
  (`cachedPromptTokens / promptTokens`), and the $ breakdown already computed in
  `pricing.ts`.
- **Target signal:** healthy long sessions should show cache-hit rate climbing
  toward >80% and output as the dominant *cost* line even though it's the
  smallest *count* line. If hit rate is low, item 3 is the priority; if output
  $ dominates, item 2 is.
- **Files:** `src/telemetry/sessionTelemetry.ts` (aggregate + expose),
  `src/telemetry/statusline.ts` (optional live hit-rate), reuse
  `pricing.ts:estimateCost`.
- **Risk:** none — read-only reporting. Ship this alone first; it tells us how
  much the rest is worth.

### 2. Cut output tokens (the 40× lever)

Output is the single most expensive token class. Levers, cheapest first:

- **Terser responses.** Tighten `systemPrompt.ts` to discourage preambles,
  postambles, and restating tool output. This is the one genuinely useful piece
  of the old "system prompt compression" idea — but the win is *fewer output
  tokens*, not a smaller (already-cached) prompt.
- **Model selection.** `deepseek-reasoner` / `-v4-pro` emit large
  chains-of-thought billed at output rate. Confirm routine agent turns default to
  `deepseek-v4-flash` and reserve reasoner for genuinely hard steps. Check the
  routing/model-selection path (`src/models/`, `src/routing/`).
- **Kill wasted turns.** Every retried or redundant tool call costs a fresh
  assistant message (output) + round-trip latency. Reduce them with *correct*
  guidance (see item 5) and by surfacing tool errors clearly so the model fixes
  rather than retries blindly.
- **Files:** `src/agent/systemPrompt.ts`, model-routing modules.
- **Risk:** over-terse prompting can hurt answer quality — validate on evals, not
  vibes. Gate behind the eval suite (`evals/`).

### 3. Protect the prefix cache (turns 0.27 input into 0.027)

The cache rewards a byte-stable prefix and append-only history. Make these
invariants explicit and defended so a future change doesn't silently bust them.

- **Audit the prefix for volatile content.** Any date, timestamp, counter, or
  per-turn state that leaks into `systemPrompt.ts` or the *head* of the message
  array invalidates the cache for the whole rest of the prompt every turn. Add a
  test asserting the rendered system prompt is identical across two turns with
  the same session inputs.
- **Keep ephemeral context appended at the end.** `withEphemeralContext` already
  does this — document the invariant and add a guard/test so todos/JIT blocks are
  never prepended or interleaved into history.
- **Compact LATE and RARELY — do *not* lower the threshold.** This directly
  reverses the old draft. Compaction rewrites history, so the *next* turn is a
  full cache **miss**: the entire (smaller) prompt reprocesses at 0.27/M instead
  of 0.027/M. On a 1M-budget DeepSeek session, compacting at 50% would trade a
  cheap large cached prompt for repeated expensive reprocessing. Keep
  `compactAt` high (0.8+); if anything, raise it. The real compaction win is a
  *good summary that doesn't re-trigger* — see item 6.
- **Files:** `src/agent/systemPrompt.ts` (+ stability test),
  `src/agent/agentLoop.ts` (invariant guard), `src/context/compaction.ts`.
- **Risk:** low; mostly additive guards. The behavior change is "don't lower the
  threshold," i.e. *not* doing the harmful thing.

### 4. Bound fresh input = tool results (one-time miss + ongoing cached carry)

A new tool result is fresh input the turn it appears, then cached carry every
later turn. Tighter caps shrink both — but tune by evidence from item 1, and
**stay line-based** to match the existing `outputBound.ts` convention (byte
slicing cuts mid-line and can split UTF-8).

- Add per-tool line caps *through the existing helpers* (`capLines` /
  `truncateByLines` in `outputBound.ts`), not a new byte-slice function. Wire any
  tool that doesn't already bound output.
- **Do not aggressively cap `read_file`.** An 8 KB read cap fights the model's
  own targeted reads and the read-nudge below — leave read generous and rely on
  offset/limit guidance instead.
- Always keep the explicit truncation marker (already standard:
  `"… (N of M lines shown; truncated)"`) so the model knows more exists.
- **Optional read nudge:** when the model reads a large file with no
  offset/limit, append a short reminder to read in chunks. **Prereq:** there is
  no `ctx.notice` channel today — this needs a one-shot ephemeral-reminder hook
  added to `ToolContext`/`withEphemeralContext` first. Scope it as its own slice;
  don't assume `ctx.notice?.()` exists.
- **Files:** `src/tools/outputBound.ts`, individual tool `execute()` methods,
  `src/tools/readFile.ts`, `src/tools/types.ts` (notice channel, if pursued).
- **Risk:** truncating output the model actually needs causes re-reads (more
  output + turns) — net-negative if too tight. Pick caps from item-1 data.

### 5. Fewer / non-redundant turns (latency + output)

Reduce round-trips with guidance that is *actually true* for our tools:

- `grep` already takes a `glob` **filter** param (`grep.ts:17`) — nudge the model
  to filter file sets inside `grep` rather than `glob`-then-`grep`. **But** do
  not tell it "grep replaces glob": `glob` finds files by *name*, `grep` searches
  *contents* — different jobs. Word the nudge precisely or it teaches a false
  affordance.
- Encourage batching independent tool calls in one turn (parallel reads) where
  the loop supports it.
- Be careful with "don't read a file you grepped" — grep returns only matching
  lines; the model often legitimately needs surrounding context. Frame as "reuse
  grep output when it already answers the question," not an absolute ban.
- **Files:** `src/agent/systemPrompt.ts`.
- **Risk:** wrong nudges cost more than they save (false affordance → failed
  calls → retries). Validate on evals.

### 6. Tighter compaction summary (independent of threshold)

The win here is summary *quality*, not earlier triggering. A summary that drops
resolved todos and keeps only in-progress/blocked items plus the original task
is smaller **and** less likely to immediately re-cross the threshold (which would
force another cache-busting compaction).

- **Files:** `src/context/compaction.ts`.
- **Risk:** dropping too much context causes the model to re-derive work (more
  output + turns). Keep the original task and active todos verbatim.

## Suggested sequencing

1. **Item 1 (measure)** — ship alone, gather a few real sessions of data.
2. Read the data: is cost output-dominated (→ item 2) or hit-rate-poor (→ item 3)?
3. Implement the indicated item, re-measure, repeat.
4. Items 4–6 are incremental tuning, justified by item-1 numbers, not guesses.

Each item is independently shippable and independently measurable. No item
depends on the broken schema-omission idea.

## Honest savings expectation

Because tool schemas and the system prompt already live in the cached prefix
(0.027/M), shaving input tokens yields little. The real, measurable wins are:

- **Output reduction** (item 2) — highest $/token leverage by 40×.
- **Higher cache-hit rate** (item 3) — converts fresh 0.27 input to cached 0.027,
  and avoids the cache-miss cliff that *early* compaction would create.

We deliberately do **not** publish a per-turn token table until item 1 gives real
numbers; the old draft's table double-counted already-cached tokens as
full-price and inflated the result ~10×. Latency improvements (fewer output
tokens, fewer round-trips, sustained cache hits) are the user-visible win.

---

## Appendix A — why the previous draft was rejected

1. **"Omit the `tools` param after turn 0" breaks tool calling.**
   `openaiCompatible.ts:156-157,187-188` sends
   `tool_choice: input.tools.length ? "auto" : undefined`. Drop `tools` and
   `tool_choice` becomes `undefined` and the wire request carries no tools — the
   model loses the function-calling interface entirely and can only emit prose.
   Embedding schemas as text in the system prompt does **not** restore structured
   tool calls. The agent would stop working after the first turn.

2. **Its premise misreads prefix caching.** Schemas sent byte-identically every
   turn are part of the cached prefix and bill at 0.027/M
   (`pricing.ts:cachedInputPerMillionUsd`). The claimed "~10K wasted tokens/turn,
   ~3.6M/yr" are already cache-hit tokens — the saving is roughly a tenth of
   stated and the mechanism is unnecessary.

3. **`needsToolsEveryTurn` for "Anthropic" is a dead abstraction.** There is no
   Anthropic provider; deepcoder is DeepSeek-only (`factory.ts`).

4. **"General tool result: unbounded" is false.** A global byte cap exists at
   `agentLoop.ts:111-126`; `runBash.ts` and `outputBound.ts` already bound output
   with explicit markers.

5. **"Compact at 50%" is actively harmful on DeepSeek.** Compaction rewrites
   history → next turn is a full cache miss reprocessed at 10× the cached rate.
   Earlier compaction means *more* cache-miss cliffs, not savings. The draft also
   contradicted itself ("keep 0.95 for DeepSeek") when DeepSeek is the only
   provider.

6. **The read nudge assumed a `ctx.notice` hook that doesn't exist.** No `notice`
   on `ToolContext` (`tools/types.ts`); the channel must be built first.

7. **The redundant-call nudges were half-wrong.** `grep` does take a `glob`
   filter, but `glob` (find by name) and `grep` (search contents) aren't
   interchangeable, and grep returns only matching lines — "never read a file you
   grepped" would starve the model of needed context.
