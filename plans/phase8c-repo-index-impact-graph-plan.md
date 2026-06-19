# Deepcoder Phase 8C - Repo Index and Impact Graph

## Goal

Upgrade Deepcoder's repo understanding from ad hoc regex repo maps to an incremental, inspectable index that can answer:

- What files exist?
- Which files are code, tests, config, docs, generated output?
- Where are symbols defined?
- Where are they referenced?
- Which files likely depend on a changed file?
- Which checks/tests are likely relevant?

This phase should improve real-repo navigation without adding heavyweight semantic infrastructure yet.

## Source Learnings

Codex, Claude, and Gemini all lean heavily on scoped search, file filters, ignore rules, and subagents before expensive semantic retrieval. Gemini explicitly exposes file filtering settings such as respecting `.gitignore` and enabling recursive/fuzzy search. Claude troubleshooting points users to ignore large build directories when search/performance suffers. Codex uses explicit repo instructions and exploration workflows rather than relying only on opaque indexing.

Deepcoder should build a transparent lexical/symbol index first.

## Scope

In scope:

- incremental file scanner,
- `.gitignore` and `.deepcoderignore`,
- language-aware symbol extraction for TS/JS and Python,
- imports/references,
- test file classification,
- package/workspace boundaries,
- impact graph,
- target test suggestions,
- index status and rebuild commands.

Out of scope:

- embeddings,
- tree-sitter dependency unless explicitly accepted,
- full type checking,
- LSIF/LSP integration,
- code ownership from GitHub APIs,
- running tests automatically.

## Index Storage

```text
.deepcoder/index/
  repo-index.json
  repo-index.tmp
```

`repo-index.json`:

```ts
type RepoIndex = {
  version: 1;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  gitHead?: string;
  files: Record<string, IndexedFile>;
  symbols: Record<string, IndexedSymbol[]>;
  imports: Record<string, IndexedImport[]>;
  tests: Record<string, TestHint[]>;
  packages: PackageBoundary[];
  warnings: IndexWarning[];
};
```

`IndexedFile`:

```ts
type IndexedFile = {
  path: string;
  kind: "code" | "test" | "config" | "docs" | "generated" | "unknown";
  language: "typescript" | "javascript" | "python" | "json" | "markdown" | "unknown";
  bytes: number;
  mtimeMs: number;
  sha256: string;
  ignored: boolean;
  sensitive: boolean;
};
```

## Ignore Rules

Respect:

- `.gitignore`,
- `.deepcoderignore`,
- built-in ignores: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.venv`, `__pycache__`,
- sensitive path rules from `src/workspace/sensitive.ts`,
- max file size.

Add `.deepcoderignore` syntax:

```text
# same rough shape as gitignore
fixtures/large/**
generated/**
```

If `.deepcoderignore` parsing is too expensive, start with `ignore` package if already present or a small glob helper consistent with existing code.

## Language Indexers

Interface:

```ts
interface LanguageIndexer {
  language: IndexedFile["language"];
  canIndex(path: string): boolean;
  indexFile(input: { path: string; text: string }): LanguageIndexResult;
}
```

TS/JS v1:

- function declarations,
- exported functions/classes/constants,
- imports from relative modules,
- simple references by identifier.

Python v1:

- def/class,
- imports/from imports,
- pytest test functions,
- simple references by identifier.

Accuracy target:

```text
good enough to guide search, not a compiler
```

## Tools

Native read-only tools:

```text
repo_index
find_references
impact_graph
target_tests
```

`repo_index`:

```json
{ "pathPrefix": "src/solve", "kind": "code", "limit": 50 }
```

Returns matching indexed files and high-level package/domain hints.

`find_references`:

```json
{ "symbol": "runSolveLoop", "pathHint": "src/solve" }
```

Returns definitions, likely references, and confidence.

`impact_graph`:

```json
{ "paths": ["src/solve/solver.ts"] }
```

Returns:

- direct importers,
- direct imports,
- nearby tests,
- check suggestions,
- config files,
- package scripts.

`target_tests`:

```json
{ "changedPaths": ["src/solve/solver.ts"] }
```

Returns suggested configured checks and candidate shell commands, but never executes them.

## Slash Commands

```text
/index status
/index rebuild
/index explain <file>
/index search <query>
```

`/index status`:

- indexed file count,
- ignored file count,
- last build,
- stale file count,
- warnings.

`/index explain <file>`:

- why file was included/skipped,
- symbols found,
- imports found,
- test classification,
- relevant instructions/memory if later phases are present.

## Update Strategy

Start simple:

- rebuild on `/index rebuild`,
- auto-refresh stale files at session start if cheap,
- update touched files after `edit_file`/`write_file`.

No daemon.

No watcher.

Atomic write:

```text
repo-index.tmp -> repo-index.json
```

If corrupted:

- warn,
- rebuild,
- continue without blocking the agent.

## Files

New:

- `src/index/types.ts`
- `src/index/ignore.ts`
- `src/index/scanner.ts`
- `src/index/store.ts`
- `src/index/languages/typescript.ts`
- `src/index/languages/python.ts`
- `src/index/impact.ts`
- `src/index/testTargeting.ts`
- `src/tools/repoIndex.ts`
- `src/tools/findReferences.ts`
- `src/tools/impactGraph.ts`
- `src/tools/targetTests.ts`

Edited:

- `src/tools/registry.ts`
- `src/tools/editFile.ts`
- `src/tools/writeFile.ts`
- `src/cli/slashCommands.ts`
- `src/cli/repl.ts`
- `src/config/fileConfig.ts`
- `.gitignore` if needed.

Tests:

- `test/index.test.ts`
- `test/adversarial/repo-index.test.ts`

## Adversarial Tests

1. Index skips `.env`.
2. Index skips `.deepcoder/runs/`, sessions, checkpoints.
3. Index respects `.gitignore`.
4. Index respects `.deepcoderignore`.
5. Index corruption does not crash startup.
6. Symlink outside workspace is skipped.
7. Large file is skipped with warning.
8. `target_tests` suggests but does not execute.
9. `impact_graph` does not include ignored tests.
10. A malicious filename cannot inject prompt text into tool output.
11. Incremental update removes deleted files from index.
12. `find_references` returns bounded results.

## Acceptance

No-model:

```bash
npm run typecheck
npm run test:phase
```

Fixture:

1. Build TS fixture with `src/a.ts`, `src/b.ts`, and `test/a.test.ts`.
2. `/index rebuild`.
3. `find_references` finds imports and references.
4. `impact_graph src/a.ts` returns `src/b.ts` and `test/a.test.ts`.
5. `target_tests src/a.ts` suggests the fixture test command.

Local-bench:

- run one `repo-hard-*` case,
- compare file reads/tool calls before and after using `impact_graph`,
- no solved-count regression.

## Rollout

Ship index tools as read-only. Keep old `repo_map` and `find_symbols` during transition. Once stable, implement them on top of the new index.

