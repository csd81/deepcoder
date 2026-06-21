# Deepcoder Phase 8A - Instruction Graph

## Goal

Replace Deepcoder's current first-match project-instructions loader with an inspectable, hierarchical instruction graph.

This phase makes Deepcoder answer these questions deterministically:

- Which instruction files were loaded?
- Why were they loaded?
- In what order were they applied?
- Which instruction files were skipped?
- Did imports expand safely?
- Are there obvious conflicts?
- Which path-local instructions apply after reading a file?

This is the foundation for later memory and context intelligence.

## Source Learnings

Codex loads durable guidance from `AGENTS.md` with global and project scope, walking from repo root to current directory and applying closer files later. Gemini loads hierarchical `GEMINI.md` files and has just-in-time context when tools access directories. Claude loads `CLAUDE.md` / `CLAUDE.local.md`, includes subdirectory instructions only when relevant, and exposes `/memory` so users can inspect what is loaded.

Deepcoder should copy the observable mechanics, not the branding:

- checked-in guidance beats hidden memory,
- path-local rules should load only when path-local files become relevant,
- instruction loading must be inspectable,
- imports must be bounded and safe,
- conflicts should be surfaced rather than silently guessed.

## Scope

In scope:

- global + workspace instruction discovery,
- nested path instructions,
- just-in-time path-local instructions,
- safe `@file.md` imports,
- source tracking,
- conflict warnings,
- `/memory show|reload|sources|conflicts`.

Out of scope:

- auto memory,
- semantic retrieval,
- repo index,
- hooks enforcement,
- skill activation,
- model-generated instruction edits.

## Supported Files

Supported instruction filenames:

```text
AGENTS.override.md
AGENTS.md
CLAUDE.local.md
CLAUDE.md
GEMINI.md
.deepcoder/instructions.md
.deepcoder/rules/*.md
```

Order inside one directory:

```text
AGENTS.override.md replaces AGENTS.md
CLAUDE.local.md follows CLAUDE.md
.deepcoder/instructions.md follows shared files
.deepcoder/rules/*.md follows .deepcoder/instructions.md
```

The plan intentionally supports Codex, Claude, Gemini, and Deepcoder-native names so users migrating between tools can reuse existing context files.

## Discovery Model

At session start:

1. Find workspace root.
2. Load global Deepcoder instruction file from `~/.deepcoder/AGENTS.md` if present.
3. Walk from workspace root to current working directory.
4. For each directory, load at most the supported files in the local precedence order.
5. Expand safe imports.
6. Build a `InstructionGraph`.
7. Inject a bounded rendered instruction block into the system/user prompt path already used by `buildSystemPrompt`.

At tool read time:

1. When `read_file`, `grep`, `glob`, or repo context tools access paths, ask the instruction graph for path-local instructions under those paths.
2. If new JIT instructions apply, inject an ephemeral context message before the next model call.
3. Track those JIT sources in session state so `/memory show` can report them.

JIT instructions should not be injected repeatedly. A source is injected once per session version unless `/memory reload` changes the graph.

## Data Model

```ts
type InstructionSourceKind =
  | "global"
  | "workspace"
  | "nested"
  | "local"
  | "rule"
  | "import"
  | "jit";

type InstructionSource = {
  id: string;
  path: string;
  kind: InstructionSourceKind;
  directory: string;
  loadedAt: "startup" | "jit";
  reason: string;
  bytes: number;
  importedBy?: string;
  skipped?: boolean;
  skipReason?: string;
};

type InstructionGraph = {
  version: string;
  workspaceRoot: string;
  cwd: string;
  sources: InstructionSource[];
  renderedStartupText: string;
  renderedJitTextBySourceId: Record<string, string>;
  warnings: InstructionWarning[];
};
```

Warnings:

```ts
type InstructionWarning =
  | { kind: "budget_exceeded"; sourcePath: string; message: string }
  | { kind: "import_cycle"; sourcePath: string; importPath: string; message: string }
  | { kind: "unsafe_import"; sourcePath: string; importPath: string; message: string }
  | { kind: "conflict"; sourcePaths: string[]; message: string };
```

## Import Processor

Syntax:

```md
@./relative.md
@../shared/testing.md
```

Rules:

- relative imports resolve from the containing file,
- absolute imports are disabled by default,
- imported files must stay inside allowed roots,
- imports cannot read sensitive paths,
- max depth defaults to `4`,
- max imported file size defaults to `64 KiB`,
- cycle detection reports a warning and skips the repeated edge,
- imported content is attributed in `/memory sources`.

Config:

```json
{
  "context": {
    "instructionImports": true,
    "instructionImportMaxDepth": 4,
    "instructionImportMaxBytes": 65536
  }
}
```

## Conflict Detection

This is a warning system, not a proof engine.

Detect obvious conflicts:

- package manager: `npm` vs `pnpm` vs `yarn`,
- test runner: `pytest` vs `unittest`, `npm test` vs `vitest`,
- formatting: `tabs` vs `spaces`, `2 spaces` vs `4 spaces`,
- strict behavior: "never edit generated files" vs "edit generated files",
- check commands declared more than once.

Output example:

```text
/memory conflicts
conflict: package manager guidance differs
- AGENTS.md: "use pnpm"
- services/api/CLAUDE.md: "use npm"
```

Do not choose a winner beyond normal merge order. The user should fix unclear instructions.

## Slash Commands

```text
/memory show
/memory reload
/memory sources
/memory conflicts
```

`/memory show` prints the rendered startup context plus loaded JIT additions.

`/memory reload` rescans instruction files, increments graph version, and updates future provider calls. It does not rewrite existing transcript messages.

`/memory sources` prints:

- path,
- kind,
- loaded at startup vs JIT,
- bytes,
- imported by,
- warnings.

`/memory conflicts` prints conflict warnings only.

## Files

New:

- `src/context/instructionGraph.ts`
- `src/context/contextFiles.ts`
- `src/context/importProcessor.ts`
- `src/context/instructionConflicts.ts`
- `src/context/instructionRenderer.ts`

Edited:

- `src/context/projectInstructions.ts`
- `src/agent/systemPrompt.ts`
- `src/agent/agentLoop.ts`
- `src/tools/readFile.ts`
- `src/tools/grep.ts`
- `src/tools/glob.ts`
- `src/cli/slashCommands.ts`
- `src/cli/repl.ts`
- `src/session/sessionStore.ts`

Tests:

- `test/instructionGraph.test.ts`
- `test/adversarial/instructions.test.ts`

## Adversarial Tests

1. Import cycle does not hang.
2. Import path cannot escape workspace without explicit approval.
3. Import path cannot read `.env`.
4. Startup budget truncates safely and reports skipped sources.
5. Nested JIT instructions load only when relevant file paths are accessed.
6. JIT instructions are injected once, not every turn.
7. `/memory reload` changes future context without mutating old transcript messages.
8. Conflicts are reported but do not crash.
9. Malformed instruction files are skipped with warnings.
10. `.deepcoder/rules/*.md` does not load files from `.deepcoder/runs/`, sessions, or checkpoints.

## Acceptance

No-model:

```bash
npm run typecheck
npm run test:phase
```

Fixture acceptance:

1. Create nested fixture:

   ```text
   AGENTS.md
   packages/api/AGENTS.md
   packages/api/GEMINI.md
   packages/web/CLAUDE.md
   ```

2. Start from `packages/api`.
3. Verify `/memory sources` shows root then package files.
4. Read a file under `packages/web`.
5. Verify `/memory sources` now includes web JIT context.
6. Verify `/memory show` includes source markers.

## Rollout

Ship behind:

```text
DEEPCODER_INSTRUCTION_GRAPH=1
```

Then make it default after tests and one local-bench run show no regressions.

