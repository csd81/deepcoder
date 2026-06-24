# Feature — Adapt Claude Code system prompt patterns for DeepSeek

## Source

~800 files extracted from Claude Code's system prompt. ~600 were Claude-specific infrastructure (cloud APIs, Chrome automation, computer use, SDK references, cloud scheduling, cowork, design sync) — not applicable to deepcoder.

## Scope — what was adapted

**197 adapted files** (the behavioral core) written to `deepcoder-system-prompts/`:

| Category | Count | Purpose |
|---|---|---|
| `system-prompt-*.md` | 40 | Behavioral rules, tone, safety, focus modes, memory, hooks, compaction |
| `tool-description-*.md` | 85 | Tool descriptions (25 core + 44 bash variants + 16 misc) |
| `system-reminder-*.md` | 15 | Mid-conversation reminders (session, plan, hooks, MCP, tokens) |
| `agent-prompt-*.md` | 41 | Subagent prompts (explore, review, security, delegation, code review) |
| `skill-*.md` | 13 | Reusable skill definitions (debugging, config, verify, stuck) |
| `data-*.md` | 3 | Reference data (DeepSeek errors, caching, tool use concepts) |

### Key behavioral rules adapted

| Claude rule | DeepSeek adaptation | Status |
|---|---|---|
| No unnecessary additions/fixes | Same — DeepSeek over-engineers | ✅ System prompt |
| No unnecessary error handling | Same — DeepSeek adds defensive guards | ✅ System prompt |
| No compatibility hacks | Same — DeepSeek leaves shims | ✅ System prompt |
| Prefer editing existing files | Same — DeepSeek creates files readily | ✅ System prompt |
| Be concise | Strengthen: no preamble | ✅ System prompt |
| Truthful failure reporting | Same — DeepSeek hedges | ✅ System prompt |
| Scope matching | Same — DeepSeek widens scope | ✅ System prompt |

### DeepSeek-specific rules added

```
- Call tools directly — no "I'll read the file now" preamble
- Tool error? Read the message and change approach. Do NOT retry same call
- Call independent tools in PARALLEL — don't serialize reads/greps
- Minimal code: no comments explaining obvious code, no inferred types
- Do exactly what was asked — no extra features, refactors, or style fixes
- No try/catch for operations that cannot fail
```

---

## Infrastructure gaps — prompts that need new code

Some adapted prompts reference features that don't exist in deepcoder yet.
Each gap needs either a plan or direct implementation.

> **Reconciled against codebase 2026-06-23.** Since this plan was written, `/learn`,
> `/insights`, `/skillify`, and LSP tools all shipped and are wired at runtime — they
> moved from "planned" to "wired". Four Section-3 items advanced to PARTIAL. The
> "deferred" plans were **relocated** (not deleted) when `plans/new/` was reorganized
> into topic dirs (commit `b739212`). Status counts below were recomputed and now
> sum consistently to 197.

### 1. ✅ Already wired (infra exists)

| Prompt(s) | Infrastructure |
|---|---|
| `system-prompt-*.md` (behavior, tone, safety, conciseness) | `src/agent/systemPrompt.ts` — system prompt builder |
| `tool-description-*.md` (read, edit, write, grep, glob, etc.) | `src/tools/*.ts` — tool descriptions |
| `system-prompt-memory-*.md` | `src/memory/store.ts` — `/memory remember/forget/inbox` |
| `system-prompt-hooks-configuration.md` | `src/hooks/` — Phase 7B lifecycle hooks |
| `system-prompt-context-compaction-summary.md` | `src/context/compaction.ts` — compaction |
| `system-reminder-plan-mode-*.md` | `src/cli/slashCommands.ts` — `/plan` |
| `system-prompt-agent-memory-instructions.md` | `src/memory/store.ts` |
| `skill-*.md` (debugging, config, verify, stuck) | `src/skills/` — Phase 7C skills system |
| `agent-prompt-verifier-*.md` | `src/delegate/verifyFindings.ts` — ✅ Implemented |
| `system-prompt-autonomous-delegation-*.md` | `src/delegate/assess.ts` — ✅ Implemented |
| `system-prompt-learning-mode*.md` | `src/cli/learnMode.ts` — `/learn` (`slashCommands.ts:289`) ✅ Shipped |
| `system-prompt-insights-*.md` (9 files) | `src/cli/sessionInsights.ts` — `/insights` (`slashCommands.ts:2841`) ✅ Shipped |
| `system-prompt-skillify-current-session.md` | `src/cli/skillify.ts` — `/skillify` (`slashCommands.ts:1146`) ✅ Shipped |
| `tool-description-lsp.md` | `src/tools/lspTools.ts` (`lsp_definition/diagnostics/references`, registered `sessionFactory.ts:306`) + `find_references/find_symbols` ✅ Shipped |
| `system-prompt-model-escalation.md` | `src/models/escalation.ts` — automatic Flash→Pro escalation, reuses ModelRouter (commit d240ddf, wired in `agentLoop.ts`/`repl.ts`) ✅ Shipped |
| `system-reminder-token-usage.md` | `src/agent/tokenUsageReminder.ts` (`formatTokenUsageReminder`/`shouldEmitTokenUsageReminder`) injected at `agentLoop.ts:216` ✅ Shipped (was mislabeled PARTIAL) |
| `system-prompt-doing-tasks-{ambitious-tasks,security,software-engineering-focus}.md` | **Surfaced via loader** — `src/prompts/corpus.ts` + `src/prompts/manifest.ts`; emitted into the live prompt's `## Engineering discipline` section (`systemPrompt.ts`). These three weren't previously in the prompt at all. |

> **Prompt-corpus loader (2026-06-24).** `src/prompts/corpus.ts` (`loadCorpusPrompt`) is the
> single sanctioned bridge from `deepcoder-system-prompts/` into runtime text, and
> `src/prompts/manifest.ts` (`corpusStatus`/`corpusPlan`) classifies every file so future
> wiring is a deliberate status change. See `deepcoder-system-prompts/README.md`.
> Status of all 197: surfaced 3, wired-inline 4, skills-loadable 13, needs-infra 15
> (each with a plan, asserted by `test/prompt-corpus.test.ts`), loader-available 48,
> reference-only 114.

### 2. 🔧 Need feature implementation (planned elsewhere)

All Section-2 items have shipped; the former lone entry (`system-reminder-token-usage.md`)
moved to Section 1.

> Shipped since last edit (moved to Section 1): `/learn`, `/insights`, `/skillify`
> (plans now under `plans/cli/` and `plans/new/feat-skillify-plan.md`), LSP
> (`tool-description-lsp.md`; plan at `plans/lsp/feat-lsp-integration-plan.md`), and
> model escalation (`src/models/escalation.ts`; plan at `plans/new/feat-model-escalation-plan.md`).

### 3. ✅ Were "need new infrastructure" — now shipped (verified 2026-06-24)

Every "worth building" item below was **re-verified against the codebase on 2026-06-24**
(see commit wiring the prompt-corpus loader). All have shipped except two whose core
logic + tests exist but whose final slash command isn't wired (`partial`). The plans
listed are the originals (relocated from `plans/new/` into topic dirs); for shipped items
they are historical, for `partial` items they track the remaining wiring.

| Prompt(s) | Status (verified) | Evidence |
|---|---|---|
| `agent-prompt-security-monitor-*.md` (3 files) | ✅ **Shipped** | `src/security/{monitor,rules}.ts` (HARD/SOFT rules) wired into preToolUse at `repl.ts`; `riskAssessor` profile; `test/security-monitor.test.ts`. |
| `agent-prompt-code-review-*.md` (3 part files) | ✅ **Shipped** | `src/delegate/multiAngleReview.ts` — 8-angle fan-out + dedup + recall-biased verify; `/review --effort high`; `test/adversarial/multi-angle-review.test.ts`. |
| `agent-prompt-agent-creation-architect.md` | ✅ **Shipped** | `src/subagents/customProfiles.ts` (discover/sanitize/merge) + `/agent-create` (`slashCommands.ts`); `test/agent-create.test.ts`. |
| `agent-prompt-simplify-slash-command.md` | ✅ **Shipped** | `simplifier` profile (`profiles.ts`), `/simplify [--fix]` (`slashCommands.ts`); `test/adversarial/simplify-command.test.ts`. (Minor: not in `slashCatalog.ts`.) |
| `agent-prompt-plan-mode-enhanced.md` | ✅ **Shipped** | `src/cli/planMode.ts` `PlanPhase` state machine + repl approval loop; `test/plan-mode.test.ts`. |
| `agent-prompt-background-*.md` (2 files) | ✅ **Shipped** | `src/subagents/background.ts` (`&research`/`&review`/`&status`, 2-job cap, exports); `test/background-subagent.test.ts`. |
| `tool-description-enterworktree.md`, `-exitworktree.md` | ✅ **Shipped** | `src/tools/{enterWorktree,exitWorktree}.ts` (model-callable), registered in `registry.ts`; `test/adversarial/worktree-tools.test.ts`. |
| `agent-prompt-batch-slash-command.md` | ✅ **Shipped** | `src/delegate/batchPlan.ts` + `/batch <goal> [--max-concurrency <n>]` (`slashCommands.ts`, decompose → convert → `runRunnableConcurrent`); `test/batch-command.test.ts`. |
| `agent-prompt-session-search.md` | ✅ **Shipped** | `src/session/sessionSearch.ts` + `/sessions search <query>` (`slashCommands.ts`); `test/session-search.test.ts`. |
| _(no source prompt)_ Coordinator mode / Remote planning | ⏳ **Not re-verified** | No dedicated corpus file, so not in the loader manifest. Plans: `plans/delegation/feat-coordinator-mode-plan.md`, `plans/session/feat-remote-planning-plan.md`. |
| `system-reminder-cross-session-*.md` (6 files) | ⛔ Out of scope | Peer-agent messaging — not relevant for single-session CLI. |
| `tool-description-croncreate.md`, `-pushnotification.md` | ⛔ Out of scope | Cloud cron + push. |
| `tool-description-computer-*.md`, `-chrome-*.md` | ⛔ Out of scope | GUI automation. |

> The per-file source of truth for these statuses is now `src/prompts/manifest.ts`
> (`corpusStatus`/`corpusPlan`), enforced by `test/prompt-corpus.test.ts` (which asserts
> each `partial` file names an existing plan).

### 4. ✅ Previously deferred — also shipped

The features once listed here as deferred have since shipped and moved into Section 3:
background subagents (`src/subagents/background.ts`), plan-mode enhancement
(`src/cli/planMode.ts`), and batch orchestration (`src/delegate/batchPlan.ts` + the
`/batch` command in `slashCommands.ts`).

---

## Status summary

The authoritative per-file breakdown is now `src/prompts/manifest.ts` (`corpusStatus`),
computed by `corpusStatusCounts()` and asserted in `test/prompt-corpus.test.ts`. Verified
against the codebase 2026-06-24:

| Status | Count | Meaning |
|---|---|---|
| `surfaced` | 3 | Loaded into the live system prompt via the loader (engineering-discipline rules). |
| `wired-inline` | 19 | Feature/concept already implemented + tested in src. |
| `skills-loadable` | 13 | Consumable via the skills system. |
| `loader-available` | 48 | Eligible to be surfaced via the loader; not yet wired. |
| `reference-only` | 114 | Code is the source of truth (tool descriptions, subagent prompts, data). |
| **Total** | **197** | |

**No file remains blocked on unbuilt infrastructure, and none is partial.** Everything the
earlier reconciliation listed under "need new infra" has shipped — the last two lagging a
CLI command (`/batch`, `/sessions search`) were wired on 2026-06-24. The 48
`loader-available` files are eligible to be pulled
into prompts via `loadCorpusPrompt` whenever they carry net-new guidance (the 3 `surfaced`
files are the first of these); the 114 `reference-only` files (tool descriptions, subagent
prompts) are intentionally owned by code — see `docs/claude-prompt-patterns.md`.

## Files

- `deepcoder-system-prompts/` — 197 adapted prompt files (+ `README.md` orientation)
- `src/prompts/corpus.ts` — loader (`loadCorpusPrompt`, path-confined, cached)
- `src/prompts/manifest.ts` — per-file status registry (`corpusStatus`/`corpusPlan`)
- `test/prompt-corpus.test.ts` + `test/adversarial/prompt-corpus-safety.test.ts` — coverage
- `docs/claude-prompt-patterns.md` — reference doc mapping Claude→DeepSeek patterns
- This plan — tracks infrastructure gaps
