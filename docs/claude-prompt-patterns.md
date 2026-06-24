# Claude Code prompt patterns — what we adapted for DeepSeek

Curated reference distilled from Claude Code's published system-prompt corpus. The
adapted corpus itself lives in `system-prompts/` (see its `README.md` for what
each file is and how files reach runtime via `src/prompts/`). This file records which
patterns we adopted, which we strengthened for DeepSeek, and which were already in place.
It is a reference for future prompt work, not runtime config.

## Behavioral rules

| Claude rule | DeepSeek adaptation | Status in deepcoder |
|---|---|---|
| Don't add features/abstractions beyond the task | Same — DeepSeek over-engineers more | Already in `systemPrompt.ts` ("do exactly what was asked") |
| Don't add error handling for impossible states | Same — DeepSeek adds defensive guards | Already ("no defensive checks for impossible states") |
| Avoid backward-compat hacks, re-exports, removed-code comments | Same — DeepSeek leaves shims | **Added** ("No backward-compatibility shims…") |
| Prefer editing existing files over creating new ones | Strengthen — DeepSeek creates files readily | **Added** ("Prefer editing an existing file…") |
| Be concise | Strengthen: "No preamble, no 'I've made the following changes:'" | Already ("Be extremely concise…") |
| Truthful reporting: if tests fail, say so | Same — DeepSeek sometimes hedges | **Added** ("Report outcomes truthfully…") |
| Match action scope to what was requested | Same — DeepSeek widens scope | Already ("do exactly what was asked, nothing more") |
| Call tools directly; no "I'll do X" narration | Critical for DeepSeek | Already ("Call tools directly…") |
| On tool error, change approach; don't retry the same call | Critical for DeepSeek | Already (base Rules + DeepSeek section) |
| Batch independent tool calls in parallel | Critical for DeepSeek | Already (base: "Batch INDEPENDENT tool calls…") |

## Delegation (deepcoder-specific, no Claude analogue)

DeepSeek never reached for the `delegate` tool on its own (0 calls on a neutral
multi-subsystem audit; 149 serial tool calls, ran out before finishing). We close this
with three reinforcing layers — see
`plans/new/feat-autonomous-delegation-assessment-plan.md`:

1. **Per-prompt machinery** — `src/delegate/assess.ts` classifies each substantial
   prompt and injects a one-shot advisory hint (`deps.delegationHint`) toward
   `delegate` for broad/multi-area work. Advisory only; never invokes delegation.
2. **Standing system-prompt rule** — the `## Delegation` block in `systemPrompt.ts`.
3. **Sharper tool description** — `delegateTool.ts` now says *when* to reach for it.

## Tool-description patterns (owned by the separate tool-API plan)

Per-tool description/error/output-bounding improvements (sharpen overlapping
descriptions, make errors recoverable, bound large outputs) are tracked separately and
deliberately NOT done here — only the `delegate` description was sharpened for the
delegation feature above.
