# Phase 8F — Persistent Repo Understanding Cache

## Context

Deepcoder can already build useful task-local context:

- instruction graph (8A) for project rules;
- local memory (8B) for manually stored facts;
- repo index / symbols / imports / impact graph / test targeting (8C);
- deterministic context planner + explorer brief (8D);
- semantic vectors (8E).

These pieces help the agent find relevant files for a task, but they do not yet provide a stable,
inspectable, persistent understanding of the whole codebase. Every long session still re-discovers
module purpose, invariants, public APIs, common workflows, and risk notes from scratch.

This phase adds a repo-understanding cache: bounded, hash-keyed summaries for files/modules that are
cheap to reuse, easy to inspect, and invalidated automatically when source files change. It is a
map, not truth: before editing, Deepcoder must still read the actual source files.

## Goals

- Persist per-file and per-module summaries under `.deepcoder/repo-understanding/`.
- Invalidate stale summaries by file hash and repo-index hash.
- Expose inspectable commands: build, refresh, show file/module, search.
- Feed the context planner/explorer with cached summaries as advisory context.
- Reduce token usage and repeated exploration in large repos.
- Keep summaries bounded, redacted, and never authoritative.

## Non-goals

- No automatic edits based only on summaries.
- No hidden indexing of sensitive files.
- No remote/vector database dependency.
- No requirement for live model calls in the core cache reader.
- No replacement for repo index or semantic search.

## Storage Layout

Directory:

```text
.deepcoder/repo-understanding/
  manifest.json
  files/
    <sha256-of-path>.json
  modules/
    <sha256-of-module-path>.json
```

Manifest:

```ts
export interface RepoUnderstandingManifest {
  version: 1;
  createdAt: string;
  updatedAt: string;
  repoIndexHash?: string;
  fileCount: number;
  moduleCount: number;
  generator: "deterministic" | "model-assisted";
}
```

File summary:

```ts
export interface FileUnderstanding {
  version: 1;
  path: string;
  fileHash: string;
  language?: string;
  kind: "code" | "test" | "config" | "docs" | "generated" | "other";
  generatedAt: string;
  summary: string;
  keySymbols: string[];
  exports: string[];
  imports: string[];
  invariants: string[];
  risks: string[];
  likelyTests: string[];
  stale: boolean;
}
```

Module summary:

```ts
export interface ModuleUnderstanding {
  version: 1;
  pathPrefix: string;
  fileHashes: Record<string, string>;
  generatedAt: string;
  purpose: string;
  publicApis: string[];
  importantFlows: string[];
  dependencies: string[];
  invariants: string[];
  tests: string[];
  risks: string[];
  stale: boolean;
}
```

## Summary Generation

Two modes:

### Deterministic Mode

No model call. Uses existing index data:

- file kind/language;
- symbols;
- imports;
- impacted tests;
- path and naming heuristics.

Produces basic but safe summaries. This mode is used for tests and as fallback.

### Model-Assisted Mode

Optional. Uses a read-only summarizer role from Phase 10F when available, or the main provider when
explicitly requested.

Rules:

- reads bounded source snippets;
- never reads sensitive paths;
- redacts before storing;
- output must pass a defensive shape guard;
- invalid/malformed output falls back to deterministic summary;
- summaries are advisory and marked `generator:"model-assisted"`.

## Hashing and Staleness

File summaries are valid only when:

- file exists;
- path is non-sensitive;
- current file hash matches stored `fileHash`;
- summary version matches;
- repo-index hash is compatible when present.

Module summaries are stale if any member file hash changes or disappears.

Stale summaries can still be shown with a warning, but they must not be injected into model context
unless explicitly requested.

## Commands

Add slash commands:

```text
/understand status
/understand build [--deterministic|--model] [path-prefix]
/understand refresh [path-prefix]
/understand file <path>
/understand module <path-prefix>
/understand search <query>
/understand purge
```

Behavior:

- `status` shows manifest counts and stale count.
- `build` creates summaries for indexed non-sensitive files under prefix.
- `refresh` updates only stale/missing summaries.
- `file` shows one summary and staleness.
- `module` shows aggregate summary.
- `search` lexical-searches summaries, not source.
- `purge` removes only `.deepcoder/repo-understanding/`.

All output is bounded and redacted.

## Context Planner Integration

Extend `PlannerInputs` with optional understanding cache:

```ts
understanding?: RepoUnderstandingView;
```

The deterministic planner can use summaries to improve:

- `likelyAreas`
- `mustRead`
- `riskNotes`
- `likelyChecks`

Rules:

- cached summaries can suggest files;
- before editing, actual files must still be read;
- context plan should include a risk note when it used stale or missing summaries.

## Explorer Integration

Explorer gets a compact advisory prelude:

```text
Repo understanding cache says:
- module src/auth: handles token refresh and session persistence
- file src/auth/session.ts: exports refreshSession; risks: retry loop, token expiry

Treat this as advisory. Verify by reading source before making claims.
```

The explorer should still cite source files it reads. Cache summaries are not valid citations by
themselves.

## Semantic Search Integration

Future optional enhancement: include understanding summaries as semantic chunks. In this phase,
summary search is simple lexical search to avoid coupling the cache to embedding availability.

## Safety Rules

- Never summarize sensitive files.
- Never store secrets; redact before write.
- Never treat summaries as policy or authority.
- Never inject stale summaries automatically.
- Cache writes are atomic.
- Corrupt summary files are skipped.
- Large files are summarized from bounded snippets or deterministic index data.

## Files

New:

- `src/understanding/types.ts`
- `src/understanding/hash.ts`
- `src/understanding/store.ts`
- `src/understanding/deterministic.ts`
- `src/understanding/modelSummary.ts`
- `src/understanding/search.ts`
- `test/adversarial/repo-understanding.test.ts`

Edit:

- `src/cli/slashCommands.ts`
- `src/context/contextPlanner.ts`
- `src/subagents/contextExplorer.ts`
- `src/config/config.ts` and `src/config/fileConfig.ts` if model-assisted mode needs config
- `src/workspace/sensitive.ts` only if new exclusions are needed

## Tests

No live model required for core acceptance.

1. Deterministic file summary contains symbols/imports/tests from repo index.
2. Sensitive paths are skipped.
3. Store writes manifest and summaries atomically.
4. Corrupt summary file is skipped, not thrown.
5. File hash mismatch marks summary stale.
6. Module summary stales when a member file hash changes.
7. `purge` removes only repo-understanding directory.
8. Search is bounded and redacted.
9. Planner uses fresh summaries to improve `mustRead` but does not require them.
10. Stale summaries are not injected automatically.
11. Model-assisted malformed JSON falls back to deterministic summary.
12. Output never includes secret-shaped strings.

## Rollout

### 8F.1 — Store and Deterministic Summaries

- Add types, hashing, store, deterministic file summaries.
- Add `/understand status|build|file|purge`.

### 8F.2 — Module Summaries and Refresh

- Add module grouping by path prefix.
- Add stale detection and refresh.

### 8F.3 — Search and Planner Integration

- Add lexical summary search.
- Feed fresh summaries into `buildDeterministicPlan`.

### 8F.4 — Explorer Advisory Prelude

- Include bounded fresh summaries in explorer context.
- Require source citations for claims.

### 8F.5 — Optional Model-Assisted Summaries

- Add model hook with deterministic fallback.
- Route through model/task router when available.

## Acceptance Criteria

- `npm run typecheck` and `npm run test:phase` pass.
- `/understand build --deterministic` works without a model key.
- Stale summaries are detected after file edits.
- Planner/explorer benefit from fresh summaries but still work when cache is absent.
- Sensitive files are never summarized.
- Cached summaries are visibly marked advisory.

## Open Questions

- Should model-assisted summaries be default-off forever, or enabled when a summarizer role is configured?
- Should module boundaries follow package manifests, path prefixes, or import clusters?
- Should summaries be included in semantic vector indexing later?
- Should delegated workers receive only relevant summaries, or should the parent explorer pre-digest them first?
