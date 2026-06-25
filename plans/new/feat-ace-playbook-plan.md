# feat: ACE-style grow-and-refine compaction (the playbook)

> **Status: IMPLEMENTED** on branch `feat-flight-recorder` (`test:phase` green, 2072
> tests). Shipped as a single opt-in flag (`context.playbook.enabled` /
> `DEEPCODER_PLAYBOOK`, default off) rather than a separate shadow phase, since the
> adversarial policy-invariance test makes injection safe to enable directly.
> **Reflector refinement:** lessons are recorded on the **terminal** solve outcome only
> (helpful when the run ends green; harmful only when it exhausts attempts) — recording
> every attempt made a fail→pass run net-zero and surface nothing. **Deterministic**
> Reflector (check name + changed-file basenames); the model-based Reflector is deferred.
> Files: `src/context/playbook.ts` (pure Curator + render), `playbookStore.ts`,
> `playbookSession.ts` (record glue), config `context.playbook`, `playbookContext` seam
> in `agentLoop.ts`, wiring in `sessionFactory.ts` / `repl.ts` / `solveRunner.ts`.

## Problem

deepcoder's compaction is single-shot lossy summarization: `compactIfNeeded()` →
`buildStructuredSummary()` (`src/context/compaction.ts:40,96`) replaces older turns with
one deterministic markdown recap (`## Task`, `## Files changed`, `## Unresolved items`)
plus a ~30% tail. The code already handles *re-compaction* (`extractTaskFromSummary`,
`compaction.ts:80`), which means a long session summarizes a summary.

This is exactly the **"context collapse / brevity bias"** failure mode described in
ACE (Zhang et al. 2025a, *Agentic Context Engineering: Evolving Contexts for
Self-Improving Language Models*, arXiv:2510.04618), which the Claude Code report cites
in §13.2: each re-summarization gets vaguer, and hard-won edge-case knowledge is erased.

deepcoder's *playbook* side — the 4-tier instruction graph + JIT loading
(`src/context/instructionGraph.ts`) — is the ACE-aligned complement, but it is
**author-written, never agent-cultivated**: nothing promotes "this strategy worked"
back into durable guidance.

## Goal

Add a session-scoped **playbook** that *accumulates* strategies instead of summarizing
them away. Compaction keeps shrinking working memory; the playbook is the lossless,
growing, structured complement that survives compaction.

## Design (Generator → Reflector → Curator)

- **Generator** = the existing agent loop (`runAgentLoop`, `src/agent/agentLoop.ts:180`).
  No control-flow change.
- **Reflector:** after a meaningful outcome signal — a check result (`PostCheck` hook)
  or a solve-attempt end (`SolveAttemptEnd` hook), both of which already exist in
  `src/hooks/types.ts` — emit a candidate lesson
  `{ strategy, outcome: "helpful" | "harmful", evidence, files? }`. Two backends:
  (a) **deterministic** rules derived from check pass/fail deltas (cheap, no model);
  (b) optional **model-based** Reflector on the cheaper tier (DeepSeek Flash — fits the
  repo's "Flash default, Pro for hard" cost model; see memory `model-flash-default-pro-for-hard`).
- **Curator:** deterministic merge into `.deepcoder/playbook.json` — de-dup by
  normalized strategy key, increment `helpful` / `harmful` counters, prune entries that
  cross a harmful threshold. It **never rewrites existing entries from scratch** (that
  is the collapse ACE avoids); it edits counters and appends.
- **Injection:** the playbook renders as a bounded context block via the existing
  byte-bounded instruction-rendering path (`src/context/instructionRenderer.ts`),
  alongside the instruction graph — top-N by `helpful − harmful`. It survives compaction
  because it is a *source* re-rendered each epoch (`onContextEpochReset`), not part of
  the summarized history.

## Phasing

1. **Shadow mode:** compute + persist the playbook, but **do not inject it**. Measure
   whether it accumulates sane lessons. Zero behavior change — safe to land first.
2. **Inject (opt-in):** wire into context assembly behind a config flag.
3. **(Optional) Compaction-aware:** when summarizing, fold confirmed `harmful`
   strategies into a "don't retry" note in `## Unresolved items`.

## Safety / adversarial coverage (required by the verification gate)

- **Playbook is advisory only — never policy.** Hard invariant, matching the repo's
  "untrusted text never changes policy": an entry may suggest an approach but can
  **never** widen permissions, alter the classifier, or auto-approve.
  *Adversarial test:* a poisoned lesson like `strategy: "run with sudo" — helpful` has
  **zero** effect on `src/permissions/policy.ts` / `commandMatrix.ts` decisions.
- **Prompt-injection containment:** Reflector input is tool/check output (untrusted).
  Entry text is bounded, escaped, and rendered inside a clearly-fenced advisory block.
  *Adversarial test:* injected instructions in a tool result cannot escalate via the
  playbook.
- **Transparent + editable:** plain JSON under `.deepcoder/` (gitignored, protected) —
  user-inspectable/deletable, matching the transparent-file-based-memory principle. No
  embeddings.
- **Bounded growth:** cap entry count + per-entry size; evict lowest-scored; log
  evictions (no silent truncation).

## Tests

- Unit: Curator de-dup + counter math is pure/deterministic; harmful-threshold pruning;
  top-N selection; renders within byte budget.
- Adversarial: policy-invariance, injection containment, growth bound.
- Acceptance must not need a live model: the model-based Reflector sits behind an
  injected seam with a `faux` default (per the repo's fake-provider rule).
- `npm run test:phase` green.

## Effort / risk

Medium–large, **medium risk**: touches context assembly (a safety-adjacent surface),
which is why phase 1 ships in shadow mode and the policy-invariance invariant gets an
adversarial test before any injection.

## Status

Proposed. Recommended to build **after** the Flight Recorder
([feat-flight-recorder-plan.md](feat-flight-recorder-plan.md)) so
the playbook's effect on context collapse can be measured by replaying exact turns.

## Related

- `plans/context/feat-better-compaction-plan.md`, `feat-trident-compaction-plan.md`
  (existing compaction work — review for overlap before implementing).
- `plans/context/feat-auto-memory-plan.md`, `plans/context/phase8b-inspectable-local-memory-plan.md`
  (the existing file-based memory subsystem the playbook complements).
