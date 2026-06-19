# Deepcoder Phase 8 - Context Intelligence and Repo Understanding

## Goal

Make Deepcoder better at understanding large real repositories without dumping too much code into the model.

The goal is not "add embeddings and hope." The mature tools all converge on a layered model:

1. explicit project instructions,
2. inspectable memory,
3. scoped search and repo maps,
4. isolated exploration contexts,
5. compact summaries,
6. only then optional semantic retrieval.

Deepcoder already has a basic version of this: project instructions, deterministic compaction, repo_map/find_symbols, and read-only research subagents. Phase 8 turns those into a coherent context system.

## Source Learnings

### Codex

Codex uses `AGENTS.md` as durable checked-in guidance. It discovers global and project instructions, walks from repo root to the current directory, concatenates guidance in precedence order, and caps the combined project-doc size. It treats memories as a local recall layer for stable preferences, recurring workflows, tech stacks, conventions, and pitfalls, but says team rules should live in checked-in guidance rather than memory. Codex also uses subagents for exploration and parallel work so search output does not pollute the main conversation.

Deepcoder lessons:

- Keep required team rules in checked-in files.
- Add an inspectable memory layer for recurring facts and pitfalls.
- Keep memory optional and local-first.
- Cap startup context.
- Use explorer/research subagents to collect noisy context outside the main conversation.
- Treat "repo understanding" as retrieval + summarization + audit trail, not hidden model magic.

### Gemini CLI

Gemini uses hierarchical `GEMINI.md` context files, including global, workspace, and just-in-time context files loaded when tools access a directory. It exposes `/memory show` and `/memory reload`, supports `@file.md` imports with circular-import and access safeguards, respects ignore files, and has experimental Auto Memory that mines past transcripts into reviewable memory updates and skill drafts.

Deepcoder lessons:

- Add just-in-time directory-local instructions.
- Add `/memory show` and `/memory reload`.
- Support safe imports in instruction files.
- Respect `.gitignore` and a Deepcoder ignore file during scans.
- If auto memory exists, make it review-first: propose patches/inbox items, never silently apply.

### Claude Code

Claude reads `CLAUDE.md` and `CLAUDE.local.md` by walking the directory tree, includes subdirectory instructions just in time when files are accessed, supports imports, and exposes `/memory` for loaded instruction files and auto-memory. Claude's auto memory uses a concise `MEMORY.md` entrypoint loaded at startup, with detailed topic files read on demand. Its docs emphasize that vague/conflicting instructions are unreliable; hooks are the right tool for mechanical enforcement. Claude also uses subagents to preserve context and keep exploration out of the main conversation.

Deepcoder lessons:

- Keep startup memory short and use topic files for details.
- Make memory auditable and editable markdown.
- Do not pretend memory is a policy mechanism.
- Add conflict detection for instruction files.
- Load path-scoped instructions only when relevant files are touched.
- Route large exploration through isolated subagents and return compact citations.

Sources:

- Codex manual: https://developers.openai.com/codex/codex-manual.md
- Claude memory: https://code.claude.com/docs/en/memory
- Claude subagents: https://code.claude.com/docs/en/sub-agents
- Gemini context files: https://geminicli.com/docs/cli/gemini-md/
- Gemini memory management: https://geminicli.com/docs/cli/tutorials/memory-management/
- Gemini memory imports: https://geminicli.com/docs/reference/memport/
- Gemini settings: https://geminicli.com/docs/cli/settings/
- Gemini auto memory: https://geminicli.com/docs/cli/auto-memory/

## Split Plans

This umbrella plan is now split into five implementation plans:

- `plans/phase8a-instruction-graph-plan.md`
- `plans/phase8b-inspectable-local-memory-plan.md`
- `plans/phase8c-repo-index-impact-graph-plan.md`
- `plans/phase8d-context-planner-explorer-plan.md`
- `plans/phase8e-semantic-search-plan.md`

## What Phase 8 Adds

Phase 8 is five slices:

```text
8A Instruction graph
8B Inspectable local memory
8C Repo index and impact graph
8D Context planner and explorer subagent
8E Optional semantic search
```

Semantic search stays optional and comes last, after lexical/indexed retrieval is proven.

## 8A - Instruction Graph

Replace the current first-match project instruction loader with a graph-aware loader.

Supported files:

```text
AGENTS.md
AGENTS.override.md
CLAUDE.md
CLAUDE.local.md
GEMINI.md
.deepcoder/instructions.md
.deepcoder/rules/*.md
```

Discovery:

- global user instructions: `~/.deepcoder/AGENTS.md`,
- repo root instructions,
- nested instructions from repo root to current working directory,
- just-in-time nested instructions when tools access files under a directory.

Merge order:

```text
global -> repo root -> nested path -> local/private -> just-in-time
```

Rules:

- `*.override.md` replaces the same-level base file.
- `*.local.md` is loaded after same-level shared instructions and should be gitignored.
- comments may be stripped from injected context to save tokens.
- each source is tracked with path, byte count, and loaded reason.
- total injected instruction budget defaults to `32 KiB`.

Imports:

- support `@relative/file.md` imports in instruction files,
- imports resolve relative to the file containing the import,
- max depth: `4`,
- detect circular imports,
- imported files must stay inside allowed roots unless explicitly approved,
- imported files are shown in `/memory show`.

Commands:

```text
/memory show
/memory reload
/memory sources
/memory conflicts
```

Conflict detection:

- warn on contradictory keywords like `npm` vs `pnpm`, `pytest` vs `unittest`, `tabs` vs `spaces`,
- warn when multiple files define different check commands,
- do not try to automatically resolve conflicts.

Files:

- `src/context/instructionGraph.ts`
- `src/context/imports.ts`
- `src/context/contextFiles.ts`
- edits to `src/context/projectInstructions.ts`
- edits to `src/agent/systemPrompt.ts`
- edits to `src/cli/slashCommands.ts`

## 8B - Inspectable Local Memory

Add local, markdown-based project memory.

Storage:

```text
.deepcoder/memory/
  MEMORY.md
  debugging.md
  checks.md
  architecture.md
  pitfalls.md
```

Startup:

- inject only `MEMORY.md`,
- cap loaded memory to the first `25 KiB` or configured limit,
- topic files are never loaded at startup,
- topic files are read on demand through normal tools.

Memory commands:

```text
/memory remember <fact>
/memory forget <pattern>
/memory open
/memory inbox
```

Manual memory:

- user can explicitly ask Deepcoder to remember something,
- Deepcoder writes a small markdown entry,
- secret redaction runs before write,
- memory changes are visible in gitignored `.deepcoder/memory/`.

Auto memory, v1:

- disabled by default,
- scans completed sessions only,
- ignores active/short sessions,
- never reads `.env`, `.deepcoder/runs/`, checkpoints, or sensitive paths,
- writes candidate patches to `.deepcoder/memory/inbox/`,
- user must approve before any memory file changes.

Candidate types:

- durable project fact,
- repeated verification command,
- recurring failure and fix,
- repeated user preference,
- possible skill candidate.

This intentionally mirrors Gemini's review-first auto memory and Claude's concise-memory-index model.

Files:

- `src/memory/types.ts`
- `src/memory/store.ts`
- `src/memory/inbox.ts`
- `src/memory/extractor.ts`
- edits to `src/session/sessionStore.ts`
- edits to `src/workspace/redact.ts`

## 8C - Repo Index and Impact Graph

Improve Deepcoder's current regex repo map into an incremental repo index.

Index contents:

- files and sizes,
- language,
- exported symbols,
- imported modules,
- test files,
- package/workspace boundaries,
- config files,
- likely owners/domains based on path,
- last indexed mtime/hash.

Respect:

- `.gitignore`,
- `.deepcoderignore`,
- configured max file size,
- secret path rules,
- generated/build directories.

Storage:

```text
.deepcoder/index/repo-index.json
```

Commands:

```text
/index status
/index rebuild
/index explain <file>
```

Tools:

```text
repo_index
find_references
impact_graph
target_tests
```

`impact_graph` returns:

- callers/importers,
- exports used by changed files,
- nearby tests,
- package scripts likely relevant,
- config files likely involved.

`target_tests` returns suggested check names or command snippets, but does not run them. Running still goes through the existing checks system.

Implementation:

- start with TypeScript/JavaScript and Python,
- use lightweight parsers only if already acceptable in dependency budget,
- otherwise use robust lexical extraction first,
- design `LanguageIndexer` so tree-sitter can be added later.

Files:

- `src/index/types.ts`
- `src/index/scanner.ts`
- `src/index/languages/typescript.ts`
- `src/index/languages/python.ts`
- `src/index/store.ts`
- `src/tools/repoIndex.ts`
- `src/tools/findReferences.ts`
- `src/tools/impactGraph.ts`
- `src/tools/targetTests.ts`

## 8D - Context Planner and Explorer Subagent

Add a read-only context planner that decides what context to gather before implementation.

This is not another free-form planning mode. It is a bounded preflight:

```text
task -> context plan -> targeted reads/searches -> compact cited brief -> main agent
```

Context plan output:

```json
{
  "taskSummary": "...",
  "likelyAreas": ["src/config", "src/solve"],
  "initialQueries": ["CheckConfig", "runSolveLoop"],
  "mustRead": ["src/config/fileConfig.ts"],
  "likelyChecks": ["test:phase"],
  "riskNotes": ["permissions code touched"]
}
```

Explorer subagent:

- read-only,
- cheap model by default when configured,
- no MCP in v1,
- no shell unless explicitly allowed,
- works in its own context,
- returns only a cited brief,
- parent receives the brief, not raw search noise.

Commands:

```text
/explore <question>
/context-plan <task>
/solve --preflight
```

Agent loop integration:

- optional `DEEPCODER_PREFLIGHT=1`,
- before `--solve`, run context planner,
- inject compact brief as an ephemeral context message,
- do not persist raw exploration logs in main history.

## 8E - Optional Semantic Search

Defer until 8A-8D are working.

Reason:

- embeddings add storage, model/provider choices, privacy questions, and index invalidation,
- lexical + symbol + impact graph may solve most local problems cheaper.

If added:

- opt-in only,
- local embedding provider first if available,
- store vectors under `.deepcoder/index/vectors/`,
- never embed sensitive files,
- show which snippets were retrieved and why,
- allow `/index purge`.

## Configuration

```json
{
  "context": {
    "instructionMaxBytes": 32768,
    "memoryMaxBytes": 25600,
    "jitInstructions": true,
    "respectGitIgnore": true,
    "respectDeepcoderIgnore": true,
    "autoMemory": false,
    "preflight": false
  },
  "index": {
    "enabled": true,
    "maxFileBytes": 262144,
    "languages": ["typescript", "javascript", "python"],
    "semantic": false
  }
}
```

Environment:

```text
DEEPCODER_CONTEXT_PREFLIGHT=1
DEEPCODER_AUTO_MEMORY=1
DEEPCODER_INDEX=0
```

## Adversarial Tests

1. Instruction import cycles terminate with a clear warning.
2. Instruction imports cannot read `.env`.
3. JIT instructions load only when a file under their directory is accessed.
4. Conflicting instructions are reported by `/memory conflicts`.
5. Memory write redacts key-shaped strings.
6. Auto memory writes only inbox candidates, never active memory.
7. Auto memory ignores sessions with MCP/web/external context when configured.
8. Repo index respects `.gitignore` and `.deepcoderignore`.
9. Repo index skips sensitive paths.
10. Impact graph does not suggest tests from ignored directories.
11. Explorer subagent cannot mutate files.
12. Explorer output is cited and compact, not raw dump.
13. Preflight context is ephemeral and does not permanently bloat session history.
14. Target-test suggestions do not execute commands.
15. Index corruption is tolerated: rebuild, warn, continue.

## Acceptance

No-model gate:

- `npm run typecheck`
- `npm run test:phase`
- instruction graph fixture tests,
- memory store/inbox tests,
- repo index tests on fixture projects,
- impact graph tests for TS and Python fixtures,
- explorer fake-provider tests.

Live local smoke:

1. Run `/memory show` and verify instruction sources.
2. Add nested instructions under a fixture package and confirm JIT load only after reading that package.
3. Run `/index rebuild`.
4. Ask `/context-plan` for a multi-file task.
5. Confirm the context brief cites relevant files and excludes ignored/secret files.
6. Run one local-bench repo-hard case with `--preflight` and compare attempts/context size to baseline.

Benchmark acceptance:

- No regression in local-bench solved count.
- Track average turns, tool calls, context chars, and attempts.
- The feature is useful only if it reduces wasted reads/searches or improves harder-case solve rate.

## Out of Scope

- full semantic vector search in v1,
- cloud indexing,
- external code intelligence services,
- automatic memory application without review,
- policy enforcement through memory,
- background daemon,
- IDE UI,
- cross-repo memory sharing,
- model-callable subagent spawning beyond explicit preflight.

## Implementation Order

1. Instruction graph and `/memory show|reload|sources`.
2. Safe import processor.
3. Inspectable `.deepcoder/memory/` store and explicit remember/forget.
4. Auto-memory inbox with fake extractor and tests.
5. Incremental repo index storage and `/index status|rebuild`.
6. TS/JS and Python lexical indexers.
7. `impact_graph` and `target_tests`.
8. Explorer/context-planner subagent.
9. `--preflight` integration for solve loop.
10. Optional semantic search design, only after measuring 8A-8D.

## Why This Comes After Phase 7

Phase 7 gives Deepcoder safer execution and reusable workflows:

- sandboxing protects commands,
- hooks enforce mechanical lifecycle rules,
- skills encode reusable procedures.

Phase 8 then improves judgment:

- what instructions apply,
- what project memory matters,
- which files matter,
- which tests matter,
- what context should be shown to the model.

That is the right order. Otherwise Deepcoder gets "smarter" before it is safe and inspectable enough to trust.
