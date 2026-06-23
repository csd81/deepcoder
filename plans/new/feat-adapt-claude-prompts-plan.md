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

### 2. 🔧 Need feature implementation (planned elsewhere)

| Prompt(s) | Depends on | Status |
|---|---|---|
| `system-prompt-learning-mode.md` | `/learn` mode | `feat-learn-mode-plan.md` in `plans/new/` |
| `system-prompt-insights-*.md` (9 files) | `/insights` session analysis | `feat-session-insights-plan.md` in `plans/new/` |
| `system-prompt-skillify-current-session.md` | `/skillify` | `feat-skillify-plan.md` in `plans/new/` |
| `system-prompt-model-escalation.md` | Auto Flash→Pro escalation | `feat-model-escalation-plan.md` in `plans/new/` |
| `system-reminder-token-usage.md` | Token budget tracking | `src/providers/usage.ts` — partial, needs UI |
| `tool-description-lsp.md` | LSP integration | `feat-lsp-integration-plan.md` (in plans/providers/) |

### 3. 🏗️ Need new infrastructure (not yet planned)

| Prompt(s) | What's needed |
|---|---|
| `agent-prompt-security-monitor-*.md` (4 files) | **Security monitor** — a read-only subagent that evaluates tool actions against block/allow rules. Could be wired as a pre-tool hook that flags risks before execution. New profile + hook integration. |
| `agent-prompt-code-review-*.md` (9 part files) | **Code review subagent** — deepcoder has `/review` but it's a basic read-only profile; these prompts define multi-angle review with 3-state verification. Needs enhanced review profile. |
| `agent-prompt-agent-creation-architect.md` | **Custom agent creator** — `/agent-create` command that generates custom agent definitions from natural language descriptions. |
| `agent-prompt-batch-slash-command.md` | **`/batch`** — parallel task decomposition and fan-out. Needs orchestrator integration. |
| `agent-prompt-session-search.md` | **Session search** — search past session transcripts by content. Needs session transcript indexing. |
| `agent-prompt-simplify-slash-command.md` | **`/simplify`** — code simplification review with 4 parallel review agents. |
| `system-prompt-coordinator-mode-orchestration.md` | **Coordinator mode** — multi-agent orchestration where one agent coordinates worker agents. Deepcoder has delegation but not coordinator/worker pattern. |
| `system-prompt-remote-planning-session.md` | **Remote planning** — plan on one machine, execute on another. Requires server infrastructure. |
| `tool-description-enterworktree.md`, `tool-description-exitworktree.md` | **Worktree tool** — deepcoder has workspace isolation (Phase 7D) but no model-callable `enter_worktree`/`exit_worktree` tools. |
| `system-reminder-cross-session-*.md` (6 files) | **Cross-session messaging** — peer agents communicating. Not relevant for single-session CLI. |
| `tool-description-croncreate.md`, `tool-description-pushnotification.md` | **Scheduling + notifications** — cloud cron and push. Not relevant for local CLI. |
| `tool-description-computer-*.md`, `tool-description-chrome-*.md` | **Computer use + browser** — GUI automation. Not in scope. |

### 4. ⏭️ Planned but prompt reference deferred

| Feature | Plan has moved | Notes |
|---|---|---|
| Background subagents | Plan was in `plans/new/` (deleted/moved) | `agent-prompt-background-*.md` references this |
| Plan mode enhancement | `feat-plan-mode-plan.md` was in `plans/new/` | `agent-prompt-plan-mode-enhanced.md` |
| Batch/orchestration | `feat-master-delegation-workflow.md` was in `plans/new/` | `agent-prompt-batch-slash-command.md` |

---

## Status summary

| Category | Total | ✅ Adaptable now | 🔧 Needs planned feature | 🏗️ Needs new infra | ⏭️ Deferred |
|---|---|---|---|---|---|
| System prompts | 40 | 28 | 8 | 4 | 0 |
| Tool descriptions | 85 | 83 | 1 | 1 | 0 |
| System reminders | 15 | 12 | 1 | 2 | 0 |
| Agent prompts | 41 | 10 | 0 | 12 | 19 |
| Skills | 13 | 13 | 0 | 0 | 0 |
| Data | 3 | 3 | 0 | 0 | 0 |
| **Total** | **197** | **149** | **10** | **19** | **19** |

149 of 197 files are directly usable with existing deepcoder infrastructure.
10 need features already planned. 19 need new infrastructure (12 worth building, 7 not in scope). 19 are deferred (plans moved elsewhere).

## Files

- `deepcoder-system-prompts/` — 197 adapted prompt files
- `docs/claude-prompt-patterns.md` — reference doc mapping Claude→DeepSeek patterns
- This plan — tracks infrastructure gaps
