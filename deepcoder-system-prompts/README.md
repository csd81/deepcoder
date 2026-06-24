# Adapted prompt corpus

197 markdown files adapted from Claude Code's published system-prompt corpus (each
carries an `<!-- adapted-from: … -->` provenance marker), reworked for DeepSeek. This is
**reference / source material**, not configuration.

## What is authoritative

The live, runtime system prompt is built **programmatically** in
`src/agent/systemPrompt.ts`; tool descriptions live on each tool in `src/tools/*.ts`;
subagent guidance lives in `src/subagents/profiles.ts`. **Where a file here overlaps live
code, the code wins** — e.g. the `system-prompt-doing-tasks-no-*` rules are already
expressed (with tuned wording) inline in `systemPrompt.ts`; the files are the historical
source, not a second copy to keep in sync.

## How files reach runtime

Files are **not** loaded wholesale at startup. The single sanctioned bridge is
`src/prompts/corpus.ts` (`loadCorpusPrompt(name)`), and `src/prompts/manifest.ts`
classifies every file so wiring more is a deliberate status change, not guesswork. Each
file has exactly one status:

| Status | Count | Meaning |
|---|---|---|
| `surfaced` | 3 | Loaded into the live system prompt now (`SURFACED_SYSTEM_PROMPT_FILES`). |
| `wired-inline` | 19 | Feature/concept already implemented + tested in src; file is reference only. |
| `skills-loadable` | 13 | Consumable via the skills system (`src/skills/`) if installed as a skill. |
| `loader-available` | 48 | Eligible to be surfaced via the loader; not yet wired. |
| `reference-only` | 114 | Code is the source of truth (tool descriptions, subagent prompts, data). |

Verified against the codebase on 2026-06-24: every feature the roadmap once tracked as
"needs new infrastructure" has since shipped (`wired-inline`). The last two that lagged
behind a CLI command — `/batch` (`src/delegate/batchPlan.ts`) and `/sessions search`
(`src/session/sessionSearch.ts`) — are now wired in `src/cli/slashCommands.ts`. Nothing
remains unbuilt or partial.

To make a `loader-available` rule live: add its filename to `SURFACED_SYSTEM_PROMPT_FILES`
in `src/prompts/manifest.ts`, then add an assertion in `test/prompt-corpus.test.ts`.
Tool descriptions and subagent prompts are intentionally kept `reference-only` (they are
DeepSeek-tuned in code; see `docs/claude-prompt-patterns.md`).

## File categories

`system-prompt-*` (40), `tool-description-*` (85), `system-reminder-*` (15),
`agent-prompt-*` (41), `skill-*` (13), `data-*` (3).

## Tracking

- `plans/models/feat-adapt-claude-prompts-plan.md` — the per-file adaptation roadmap.
- `docs/claude-prompt-patterns.md` — which behavioral patterns were adopted/strengthened.
