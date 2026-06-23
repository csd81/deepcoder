# Plan — Autonomous delegation assessment + DeepSeek system-prompt overhaul

## Context

deepcoder has a complete, wired delegation subsystem (`delegate` tool → read-only
subagents; `/delegate full` classifier→router; autopilot), but it **never uses it on
its own**. Two live dogfood runs prove this: on the `audit-wiring.md` task with a
neutral prompt, the model issued **0 `delegate` calls**, ground through **149 serial
tool calls / 191 messages** (115 greps, 27 reads), and hit the loop cap *before
producing a report*. With an explicit "delegate per subsystem" prompt it delegated
cleanly and finished. So the gap is **invocation, not capability**: nothing assesses
each prompt for delegability or nudges the model toward `delegate` over grinding solo.

This plan closes that gap on three reinforcing layers — per-prompt machinery
(deterministic assessment + ephemeral hint), a standing system-prompt rule, and a
sharper tool description — and folds in the non-redundant residue of
`feat-adapt-claude-prompts-plan.md` (3 missing behavioral rules + a curated reference
doc). Outcome: a re-run of the neutral audit dogfood should issue ≥1 `delegate` call
and finish.

**Safety invariants (non-negotiable):** the assessment is **advisory only** — it
injects a hint; the model still chooses. It never auto-invokes a mutating path
(`/delegate autopilot`), never escalates on classifier failure (fail-safe), and is
never given to subagents (no recursion). "A delegation never integrates itself."

---

## Part A — Per-prompt delegation assessment (the machinery)

### A1. New module `src/delegate/assess.ts` (+ `test/delegate-assess.test.ts`)
Reuse the existing `classifyTask` (`src/delegate/taskClassifier.ts:44`) — do not
re-implement classification.

- `looksDelegable(prompt: string): boolean` — **pure**, cheap pre-gate so trivial
  prompts never cost a model call. Returns true only when the prompt is substantial
  (≳160 chars) **or** carries breadth signals (`/\b(audit|every|all|across|each|
  multiple|subsystem|throughout|entire|codebase|refactor|wire|survey)\b/i`). Single
  short asks ("fix this typo") → false.
- `assessDelegation(prompt, deps): Promise<string | null>` where deps =
  `{ provider, model, signal? }`:
  1. `if (!looksDelegable(prompt)) return null;` (no model call)
  2. `const c = await classifyTask(prompt, deps)` (already fail-safe → "research")
  3. `if (c.category === "simple-edit") return null;`
  4. else return the **hint string** (below), interpolating `c.category` + `c.reason`.

Hint text (one ephemeral block):
> `[delegation assessment] This request looks like {category} — {reason}. Consider fanning out with the delegate tool (one read-only subagent per subsystem/area) instead of investigating everything serially, then act on their findings yourself. Advisory — you decide.`

### A2. Ephemeral injection (reuse the `jitContext` precedent)
The proven per-turn, history-non-mutating injection path is
`withEphemeralContext` (`src/agent/agentLoop.ts:331–340`), which already yields
`renderTodos` + `deps.jitContext?()` as `{role:"system"}` blocks for that turn only.

- Add `deps.delegationHint?(): string[]` to `AgentDeps` (`agentLoop.ts:22`) and
  consume it inside `withEphemeralContext` exactly like `jitContext` — **yield once**
  (the callback returns the hint on first call, then `[]`).

### A3. Wire at top-level call sites only (NOT subagents)
`assessDelegation` is async; `withEphemeralContext` is sync — so **precompute the hint
before `runAgentLoop`** and have `delegationHint()` return it once.

- **REPL chokepoint:** `runTask` (`src/cli/repl.ts:380`, the single site both UIs hit
  at :892 and :1668) — before `runAgentLoop` (:481), `await assessDelegation(lastUserMessage, …)`
  when `config.delegate.assess.enabled`; pass a one-shot `delegationHint` into `deps`.
- **Headless one-shot:** the `runAgentLoop` call site in the one-shot path
  (`runOneShot`) — wire identically (else the headless dogfood can't improve).
  Factor a shared `makeDelegationHint(prompt, deps): Promise<() => string[]>` so both
  sites share one implementation.
- **Subagents:** `src/subagents/runner.ts:63` must NOT receive `delegationHint`
  (prevents recursion; subagents are already focused). Add an adversarial test asserting this.

### A4. Config flag (existing env > file > default pattern, `config.ts:573–595`)
- `DelegateConfig` (`config.ts:207`) += `assess: { enabled: boolean }`;
  `DEFAULT` enabled = **true** (advisory + read-only ⇒ low risk; this is the feature
  the user wants on). Env `DEEPCODER_DELEGATE_ASSESS` (`0` disables);
  file `delegate.assess.enabled`.

### A5. Standing system-prompt rule + sharper tool description
- `src/agent/systemPrompt.ts` — add a `## Delegation` block (always present):
  - prefer `delegate` for broad/multi-area work (audits, "check every X", independent
    sub-tasks) over serial investigation; each subagent has its own context budget;
  - `delegate` is READ-ONLY (explorer/researcher/reviewer/testTriage) — gather & verify, then edit yourself;
  - don't delegate a single-file/localized change.
- `src/tools/delegateTool.ts:38` — append to the description: "Reach for this when a
  task spans multiple files/subsystems or has independent parts (audits, broad
  surveys, 'check every X') — per-area delegation keeps your context clean and runs in
  parallel. For a single-file or localized change, edit directly."

---

## Part B — System-prompt overhaul (merged from feat-adapt-claude-prompts-plan.md)

Most of that plan is **already implemented** in `systemPrompt.ts` lines 52–61
(call-tools-directly, conciseness, no-retry, do-exactly-what-asked, minimal-code) and
base line 31 (parallel batching). Only the residue below is new.

### B1. Add 3 missing behavioral rules to `systemPrompt.ts`
- **No backward-compat shims:** no re-exports kept "just in case", no commented-out
  old code, no "removed X" notes — delete cleanly. (Directly matches our recent
  dead-code cleanup.)
- **Prefer editing existing files** over creating new ones; create a file only when a
  new module is genuinely needed.
- **Truthful reporting:** if tests fail, show the output and say so; if you skipped a
  step, say that; never claim unverified success.

### B2. Curated reference doc
- **New:** `docs/claude-prompt-patterns.md` — the curated "what Claude does / what
  DeepSeek needs differently" table from the source plan, for future prompt work.

### B3. Deliberate exclusions (resolve the conflicts the source plan created)
- **DO NOT commit the raw corpus** `claude-code-system-prompts/` (528 files, IP/bloat).
  The curated doc is the only artifact that enters git.
- **DO NOT rewrite all `src/tools/*.ts` descriptions here.** That work belongs to the
  separate, surgical tool-API plan. This plan owns only the `delegate` description +
  the 3 behavioral rules.

---

## Files to change
- **New:** `src/delegate/assess.ts`, `test/delegate-assess.test.ts`,
  `docs/claude-prompt-patterns.md`.
- **Edit:** `src/agent/agentLoop.ts` (delegationHint callback + withEphemeralContext),
  `src/cli/repl.ts` (runTask wiring) + the one-shot runner, `src/config/config.ts`
  (assess flag), `src/agent/systemPrompt.ts` (delegation block + 3 rules),
  `src/tools/delegateTool.ts` (description).
- **Reuse:** `classifyTask` (`taskClassifier.ts`), the `jitContext` injection path,
  the env>file>default config pattern.

## Verification (TDD — red first on each unit)
1. **Unit:** `looksDelegable` (trivial→false, broad→true); `assessDelegation` with a
   fake provider (multi-file/broad-research→hint, simple-edit→null, provider throws→
   null/never blocks). systemPrompt renders the 3 rules + delegation block. delegate
   tool catalog/snapshot test still green.
2. **Injection:** test the hint appears in the model's prompt **exactly once** and
   only when enabled; absent when `enabled:false`.
3. **Adversarial:** classifier failure never escalates/blocks; the hint never
   auto-invokes a mutating command; subagents get no `delegationHint` (no recursion).
4. **Full gate:** `npm run typecheck` + `npm run test:phase` green.
5. **End-to-end dogfood (the acceptance bar):** re-run the neutral `audit-wiring.md`
   prompt headless (`-p`, `--mode auto --no-contain`, model `deepseek-v4-flash`) and
   confirm via the newest `.deepcoder/sessions/*.json` that it now issues **≥1
   `delegate` call** and produces a final report — versus 0 today.

## Out of scope (deliberate)
- No auto-routing to mutating paths; no auto-apply; landing stays human-gated.
- No async rework of `withEphemeralContext` (precompute before the loop instead).
- Per-tool description/error/output-bounding fixes → separate tool-API plan.
