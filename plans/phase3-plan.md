# Deepcoder Phase 3 Plan — Hardening, Context, and Scale (APPROVED)

## Context

Phases 1–2 produced a working, streaming, resumable agent. A review surfaced four real safety gaps that must close **before** expanding autonomy or context. The biggest: the command classifier allow-lists by *prefix*, so in `auto` mode commands that should never auto-run are classified `allow`. Verified against `src/permissions/commandClassifier.ts`:

- `ls; touch x` → `/^ls\b/` → **allow** (chains a file create)
- `echo hi > rel-file` → `/^echo\b/` → **allow** (only `> /abs` is dangerous) — unapproved file write
- `cat /etc/passwd` → `/^cat\b/` → **allow** — reads outside the workspace
- `git status && git checkout -- file` → git read-only rule → **allow** (chains a mutating checkout)

Phase 3 starts with a **hardening sprint** (shippable on its own), then token-aware context management, a lightweight repo map, and a `deepseek-reasoner` planning mode — all behind the existing vendor-neutral boundaries.

## Part A — Hardening sprint (land + commit first)

### A1. Command classifier: segment, don't prefix-match — `src/permissions/commandClassifier.ts`
1. **Deny** if the command contains command/process substitution (`$(`, backticks, `<(`), a fork bomb, or any explicit dangerous token (`rm`, `sudo`, `chmod`, `chown`, `mkfs`, `dd`, `shutdown`, `reboot`, `kill`, `nohup`, `curl|wget … | sh`).
2. **Split** on `;`, `&&`, `||`, `|`, `&`, newlines.
3. **`allow`** only if: no redirect (`>`/`>>`/`<`), no background `&`, and every segment's leading token is in the read-only allowlist with safe operands — no absolute paths (except `/dev/null`) and no `..`.
4. Otherwise → **`ask`** (redirects, chained unknowns, absolute-path reads, non-read-only `git` subcommands).
- git read-only set stays `status|diff|log|show|branch|remote`; other `git` → `ask`.

### A2. Atomic session saves — `src/session/sessionStore.ts`
`save()` writes `<id>.json.tmp` then `fs.rename()`. `listSessions` ignores `.tmp`.

### A3. Fresh system prompt on resume — `src/cli/main.ts` (`buildSession`)
Rebuild `messages[0]` via `systemMessage(cfg, saved.mode)` (re-reads current instructions); keep the rest of saved history.

### A4. Realpath check for mutating tools — `src/workspace/paths.ts` (+ `editFile.ts`, `writeFile.ts`)
Add `resolveRealPathInWorkspace(root, p)`: realpath the existing file (or nearest existing parent for new files) and confirm it's inside `realpath(root)`. Lexical `resolveInWorkspace` stays for read tools.

## Part B — Context budget & compaction
- `src/context/tokenBudget.ts`: approx tokens (chars/4); `estimateMessages()`.
- Config: `DEEPCODER_CONTEXT_BUDGET_TOKENS` (64000), `DEEPCODER_COMPACT_AT` (0.8).
- `src/context/compaction.ts`: over budget×threshold, summarize older turns into one message preserving current task, files read/edited, todos, key outputs, unresolved errors; keep recent raw turns; persist summaries. `/compact` forces; `/context` shows usage.

## Part C — Repo map & file scanner
- `src/context/fileScanner.ts`: `rg --files` else Node walk; ignore `.git`, `node_modules`, `dist`, `.deepcoder`, lockfiles, binaries; deterministic order.
- `src/context/repoMap.ts`: TS/JS, **regex-based symbol extraction** (dependency-free; no tree-sitter, defer TS compiler API). Inject only on broad tasks / on request.

## Part D — Reasoner planning mode
- Config `DEEPSEEK_REASONER_MODEL` (`deepseek-reasoner`); CLI `--planning-model`; slash `/plan`.
- `/plan` runs one turn vs the reasoner model with **tools disabled**, records output as assistant text. Normal loop keeps the main model. Reuses the provider boundary.

## Part E — Context tools (read-only, always allowed)
`repo_map`, `find_symbols`, `list_recent_context`.

## Part F — Docs & UX
- `ROADMAP.md` Phase 3 checklist; `README.md` compaction/repo-map/reasoner docs; slash `/compact`, `/context`, `/repo-map`, `/plan`.

## Implementation order
A (commit as its own unit) → B → C → E → D → F.

## Test plan
- Classifier: deny/ask chained side-effects, redirects, absolute-path reads, unsafe pipes, background, git mutations; still allow the safe set.
- Session store: atomic save; stray `.tmp` doesn't break load/list.
- Resume: refreshes system prompt when instructions change.
- Paths: mutation tools reject provable realpath escapes.
- Compaction: preserves todos, recent edited files, unresolved errors; respects budget.
- Scanner: ignores expected dirs; deterministic order. Repo map: extracts TS exports/functions/classes/interfaces.
- Reasoner planning: never executes tools; records plan in history.
- `npm run typecheck` + `npm test` pass; live readonly smoke test works.

## Acceptance criteria
- Phase 1+2 workflows still work.
- No `auto`-mode `allow` command can mutate files, chain into a mutation, or read arbitrary absolute paths.
- Long sessions compact without losing todos/readTracker/recent results.
- Useful repo map for deepcoder's own `src/`.
- `/plan` uses the reasoner model when configured and never runs tools.
- No MCP, subagents, auto-commit, or full OS sandboxing.

## Credentials
Fake providers for automated tests; live key only for readonly smoke tests; never print/commit the key; key is exposed → rotate.

## Progress
- [x] A1 classifier  - [x] A2 atomic saves  - [x] A3 resume prompt  - [x] A4 realpath  - [x] B compaction  - [ ] C repo map  - [ ] D reasoner  - [ ] E context tools  - [ ] F docs
