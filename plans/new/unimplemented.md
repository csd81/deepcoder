# Unimplemented / partial plans

Tracking list from a full plan audit (2026-06-24): ~90 plan docs cross-referenced
against the code. The overwhelming majority shipped (all of cli/, session/,
delegation/, subagents/, verification/, and most UI/web/routing/safety). What
remains unbuilt or partial is below. The three other-provider plans
(openai-responses, openrouter phase10j, openrouter search-routing phase10e7) were
**deleted** — this is a DeepSeek-only project.

## Fully unimplemented (no code exists)

- **`plans/new/feat-trident-compaction-plan.md`** — 3-stage deterministic
  redundancy pass (supersede -> collapse -> cluster) before summarization. No
  `src/context/trident.ts`, no `DEEPCODER_TRIDENT`. Pure/deterministic, no model
  or provider dependency. **Recommended next build** (high token-savings, composes
  with `src/context/compaction.ts`, pairs with token-efficiency W1 below).

## Partially implemented (deferred slices)

- **`plans/context/feat-token-efficiency-plan.md`** — W2 (output bounding) and W3
  (tool steering) shipped; **W1 per-turn read-budget tracking/nudge** not threaded
  into the agent loop.
- **`plans/tools/feat-tool-optimization-plan.md`** — complexity scorer +
  description tuning shipped; missing tools `read_many_files`, `update_plan`,
  `complete_task`.
- **`plans/context/feat-better-compaction-plan.md`** — deterministic structured
  summaries shipped; no `--deep` LLM-based summary mode.
- **`plans/context/phase8f-repo-understanding-cache-plan.md`** — deterministic
  `/understand` + cache shipped; model-assisted mode (8F.5) deferred.
- **`plans/tools/feat-tool-descriptions-opencode-style-plan.md`** — descriptions
  rewritten in-place; `.txt` file extraction deferred (cosmetic).

## ROADMAP follow-ups (infra-heavy, tracked in ROADMAP.md)

- In-container SWE-bench solve loop (host env can't pin per-instance deps).
- `usage` field on `ChatResponse` through every provider adapter -> per-instance
  cost telemetry.
- Harder local-bench cases (6C/6E/6F) -- current sets are one-shot solved.
- LLM/triage failure summarizer for 5B (currently deterministic).
