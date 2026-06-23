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

### 2. 🔧 Need feature implementation (planned elsewhere)

| Prompt(s) | Depends on | Status |
|---|---|---|
| `system-reminder-token-usage.md` | Token budget tracking | **PARTIAL** — `src/providers/usage.ts` + `/usage` `/cost` `/telemetry` commands exist; reminder-surfacing UI not confirmed wired |

> Shipped since last edit (moved to Section 1): `/learn`, `/insights`, `/skillify`
> (plans now under `plans/cli/` and `plans/new/feat-skillify-plan.md`), LSP
> (`tool-description-lsp.md`; plan at `plans/lsp/feat-lsp-integration-plan.md`), and
> model escalation (`src/models/escalation.ts`; plan at `plans/new/feat-model-escalation-plan.md`).

### 3. 🏗️ Need new infrastructure (not yet planned)

| Prompt(s) | What's needed |
|---|---|
| `agent-prompt-security-monitor-*.md` (4 files) | **Security monitor** — NOT STARTED. A read-only subagent that evaluates tool actions against block/allow rules. PreToolUse hook types exist (`hooks/types.ts`) but no security profile / risk-assessment impl. New profile + hook integration. |
| `agent-prompt-code-review-*.md` (9 part files) | **Code review subagent** — PARTIAL. Basic reviewer profile exists (`profiles.ts:10`) behind `/review`; these prompts define multi-angle review with 3-state verification, not yet built on top. |
| `agent-prompt-agent-creation-architect.md` | **Custom agent creator** — NOT STARTED. `/agent-create` command that generates custom agent definitions from natural language descriptions. |
| `agent-prompt-batch-slash-command.md` | **`/batch`** — PARTIAL. Internal worker batching exists (`orchestrator.ts:364` `buildRunnableBatches`); no user-facing `/batch` command/fan-out yet. |
| `agent-prompt-session-search.md` | **Session search** — PARTIAL. In-session transcript search exists (`transcriptSearch.ts`, Ctrl+F at `repl.ts:1139`); no cross-session / persistent transcript index. |
| `agent-prompt-simplify-slash-command.md` | **`/simplify`** — NOT STARTED. Code simplification review with 4 parallel review agents. |
| `system-prompt-coordinator-mode-orchestration.md` | **Coordinator mode** — PARTIAL. `/delegate` (`slashCommands.ts:1494`) + `/worker` (`slashCommands.ts:3838`) dispatch workers via `orchestrator.ts`/`workerRunner.ts`; this is task-decomposition/TDD-gated dispatch, not a symmetric coordinator/worker peer pattern. |
| `system-prompt-remote-planning-session.md` | **Remote planning** — plan on one machine, execute on another. `--serve` stdio JSON-RPC mode now exists (HEAD `84b6823`) as a building block; full remote-planning flow not built. |
| `tool-description-enterworktree.md`, `tool-description-exitworktree.md` | **Worktree tool** — NOT STARTED as model tools. `/isolation` slash command (`slashCommands.ts:1237`) manages workspace isolation CLI-side; no model-callable `enter_worktree`/`exit_worktree`. |
| `system-reminder-cross-session-*.md` (6 files) | **Cross-session messaging** — peer agents communicating. Not relevant for single-session CLI. |
| `tool-description-croncreate.md`, `tool-description-pushnotification.md` | **Scheduling + notifications** — cloud cron and push. Not relevant for local CLI. |
| `tool-description-computer-*.md`, `tool-description-chrome-*.md` | **Computer use + browser** — GUI automation. Not in scope. |

### 4. ⏭️ Planned but prompt reference deferred

Plans below were **relocated** (not deleted) when `plans/new/` was reorganized into topic dirs.

| Feature | Plan location (current) | Notes |
|---|---|---|
| Background subagents | `plans/subagents/feat-background-subagents-plan.md` | `agent-prompt-background-*.md` references this |
| Plan mode enhancement | `plans/cli/feat-plan-mode-plan.md` | `agent-prompt-plan-mode-enhanced.md` |
| Batch/orchestration | `plans/delegation/feat-master-delegation-workflow.md` | `agent-prompt-batch-slash-command.md` |

---

## Status summary

Recomputed during the 2026-06-23 reconciliation; each row sums to its category total.

| Category | Total | ✅ Wired now | 🔧 Needs planned feature | 🏗️ Needs new infra | ⏭️ Deferred |
|---|---|---|---|---|---|
| System prompts | 40 | 38 | 0 | 2 | 0 |
| Tool descriptions | 85 | 84 | 0 | 1 | 0 |
| System reminders | 15 | 12 | 1 | 2 | 0 |
| Agent prompts | 41 | 10 | 0 | 12 | 19 |
| Skills | 13 | 13 | 0 | 0 | 0 |
| Data | 3 | 3 | 0 | 0 | 0 |
| **Total** | **197** | **160** | **1** | **17** | **19** |

160 of 197 files are now usable with existing deepcoder infrastructure (up from 149 —
`/learn`, `/insights` (9 files), `/skillify`, LSP, and automatic Flash→Pro model
escalation shipped). Only 1 awaits a planned feature (the token-usage reminder UI).
17 need new infrastructure (4 of those now PARTIAL: code-review, `/batch`,
session-search, coordinator mode). 19 remain deferred (plans relocated into topic
dirs, not deleted).

## Files

- `deepcoder-system-prompts/` — 197 adapted prompt files
- `docs/claude-prompt-patterns.md` — reference doc mapping Claude→DeepSeek patterns
- This plan — tracks infrastructure gaps
