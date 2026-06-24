# Feature — Autonomous complex refactoring (multi-file edits)

<!--
  RED SEEDS (commit FIRST, must fail on baseline):
    test/refactor-planner.test.ts — RefactorPlanner discovers all usages,
      builds a structured plan, and never mutates.
    test/refactor-preview.test.ts — preview gate: show diff, wait for
      confirmation; refuse on deny.
    test/adversarial/refactor-blast-radius.test.ts — a refactor that
      touches a sensitive/forbidden path is refused; rollback on check
      failure leaves the workspace clean.
  The existing test/refactor.test.ts stays (pure helpers stay).
-->

## Context

`/refactor` exists today as a thin steering wrapper over `/solve`: it parses
`<check-name> <description>`, pushes a prompt that nudges the model toward
`find_references` / `impact_graph` + `apply_patch`, and hands off to
`runSolveCommand`. The model *can* discover all usages, but it is **nudged,
not enforced** — there is no programmatic discovery, no preview-before-mutate
step, and no rollback on failure beyond the solve loop's retry.

The pieces for full autonomy already exist:

| Capability | Existing infra |
|---|---|
| Find every reference to a symbol | `findReferences()` in `src/index/references.ts` — lexical word-boundary scan of all indexed code/test files, bounded at 200 refs, surfaced as the `find_references` model tool |
| Find transitively impacted files | `impactedBy()` in `src/index/impact.ts` — reverse-import BFS, surfaced as the `impact_graph` tool |
| Pattern search beyond simple identifiers | `grep` tool in `src/tools/grep.ts` — ripgrep with fallback, regex support, sensitive-path guards |
| Atomic multi-file edits | `apply_patch` tool in `src/tools/applyPatch.ts` — create/update/delete ops, all validated before any write, unified diff preview |
| Auto-format after edits | `formatOnEdit.ts` — runs the configured formatter on changed files after every successful mutate tool call; integrated in `agentLoop.ts:419-437` |
| Edit→check→retry loop | `runSolveLoop()` in `src/solve/solver.ts` — bounded attempts, classifier-gated checks, redacted failure feedback |
| Preflight context | `runExplorer()` in `src/subagents/contextExplorer.js` — injected as a system message before attempt 1 (`solveRunner.ts:146-166`) |

**Goal:** `/refactor` becomes a **programmatic, multi-phase pipeline** — not just a
nudge. The system discovers every affected site from the live index + grep, builds a
concrete edit plan (file → old → new, with surrounding context), shows a **preview
diff**, requires **confirmation**, executes atomically, formats, and verifies — with
explicit rollback on failure.

## Model

```
/refactor <check-name> <description>
```

Phases (run sequentially, each gates the next):

1. **Discover** (read-only, programmatic — no model): parse the description to
   identify the target (symbol name, file path, or regex pattern). Run
   `findReferences` + `impactedBy` + `grep` against the live index to produce a
   complete, bounded site list. Emit a `RefactorPlan`: `{ target, sites:
   {file, line, context}[], impactedFiles: string[] }`. If zero sites found →
   refuse with "nothing to refactor."

2. **Plan** (model-driven, read-only): feed the discovered sites + impacted files
   into a single model turn whose ONLY job is to produce a concrete edit plan —
   one `apply_patch` op per site. The model sees the full context of each site
   (surrounding lines, not just the match line). Output: a validated set of
   `PatchOp[]` that the model returns as a tool call.

3. **Preview** (gate, no model): render the unified diff of the planned patch.
   **Require user confirmation** (yes/no). On deny → abort, no files touched.
   In non-interactive/headless mode, `--yes`/`--force` skips the prompt.

4. **Apply** (mutate): execute the confirmed `apply_patch`. Atomic — all ops
   validated before any write; on validation failure, nothing is written.

5. **Format** (mutate, programmatic): for each changed file, run the configured
   formatter (reuse `formatFile` + `shouldFormat` from `formatOnEdit.ts`).
   Format failures are non-fatal (noticed, not blocking).

6. **Verify** (execute): run the named check. On pass → done. On failure →
   **rollback** via `git checkout` / `git clean` (restore working tree to the
   pre-refactor state) and report the failure. The solve loop's retry is
   deliberately **not** used for complex refactoring — a multi-site edit that
   fails the check is a wrong plan, not a "try again with minor fixes" case.
   (A `--retry` flag can opt into the solve loop instead of rollback.)

### Why not reuse the solve loop for execute+verify?

The solve loop's retry-on-failure is designed for iterative development — make an
edit, run the check, fix what broke. For a 15-site rename, this is dangerous: a
partial fix on attempt 2 could leave the tree in an inconsistent state
(half-renamed symbols). The refactor pipeline deliberately does **one atomic
apply → one verify → rollback on failure**, treating the edit as a single
transaction. The `--retry` flag is an escape hatch that re-enables the solve
loop, but the default is single-shot.

## Design

### 1. `RefactorPlanner` — programmatic discovery (new)

```
src/cli/refactorPlanner.ts
```

Does NOT call the model. Pure function of the index + grep.

```ts
export interface RefactorSite {
  file: string;          // workspace-relative
  line: number;          // 1-based
  context: string;       // the matching line + 2 lines above/below (bounded)
  kind: "definition" | "reference" | "import" | "pattern-match";
}

export interface RefactorPlan {
  target: string;           // the symbol/pattern being refactored
  sites: RefactorSite[];    // every discovered site (bounded at MAX_SITES)
  impactedFiles: string[];  // transitively impacted files (import chain)
  truncated: boolean;       // true if discovery hit a bound
}

// Bounds to keep context manageable
const MAX_SITES = 200;
const MAX_CONTEXT_LINES = 5; // 2 above + match + 2 below
```

**Discovery strategy** (tried in order, first non-empty result wins):

1. **Symbol rename** — if the description names a single valid JS/TS identifier
   (matched via `/\b[A-Za-z_$][\w$]*\b/`), call `findReferences(root, index,
   symbol)`. This covers renames of functions, classes, constants, variables.
   Returns definitions + every lexical reference across all code/test files.

2. **File move/rename** — if the description references a file path (matched
   via `/\b(src\/[\w\/.-]+\.\w+)\b/`), call `impactedBy(index, filePath)` to
   find every file that imports it. Also `grep` for the raw import specifier
   string to catch dynamic imports and require() calls the import index might
   miss.

3. **API signature change** — if the description contains a function signature
   pattern (e.g. "add a `timeout` param to `fetchUsers`"), run
   `findReferences` on the function name, then `grep` for call-site patterns
   (e.g. `fetchUsers(`) to find every invocation — the import index tracks
   *imports* but not call sites within a file.

4. **General pattern** — fall back to `grep` with a regex extracted from the
   description. The model (in the Plan phase) provides the final regex; the
   planner re-runs discovery if the model requests a different pattern.

The planner reads each discovered file once to extract context lines
(surrounding the match). Files >1 MB are skipped; binary files are skipped.
All reads are workspace-bounded (reuse `resolveReadPathInWorkspace`).

**Output cap:** if the planner finds >200 sites, it returns `truncated: true`
and the first 200, plus a warning. The model can request a narrower search.

### 2. Plan phase — model builds the edit plan

The discovered `RefactorPlan` is injected as a system message (same mechanism as
preflight at `solveRunner.ts:159`):

```
You are planning a refactor. DO NOT edit any files yet.

Target: rename displayPath to formatPath
Sites discovered (24 total, 0 truncated):

  src/workspace/paths.ts:12 (definition)
    export function displayPath(root: string, p: string): string {
      const rel = path.relative(root, p).replace(/\\/g, "/");
      return rel.startsWith("..") ? rel : rel || ".";

  src/tools/grep.ts:147 (reference)
    const rel = displayPath(workspaceRoot, abs);
    if (isSensitivePath(rel)) continue;

  ... (22 more)

Impacted files (transitive importers): src/cli/repl.ts, src/agent/agentLoop.ts, ...

For each site, produce an apply_patch update op that renames the symbol.
Read each file before editing to get the exact old_string.
Return a SINGLE apply_patch covering all sites.
```

The model runs a **single turn** (no loop) to produce the `apply_patch` call.
This is a constrained planning turn — the model reads files to get exact
old_strings, then emits the patch. Because it's a single turn, there is no risk
of the model wandering off-task.

If the model identifies additional sites the planner missed (e.g. a comment
reference), it can include those — the planner's list is advisory, not
authoritative. The model MUST still read each file before editing.

### 3. Preview gate

Before executing, render the unified diff from `planPatch()` (already computed
during the model's tool preview). Show it to the user with a confirmation
prompt:

```
Refactor: rename displayPath → formatPath
34 files, 72 update ops

--- a/src/workspace/paths.ts
+++ b/src/workspace/paths.ts
@@ -10,7 +10,7 @@
-export function displayPath(root: string, p: string): string {
+export function formatPath(root: string, p: string): string {

... (70 more hunks)

Apply this refactor? [y/N]
```

On `N` / timeout (30s) → "Refactor cancelled." No files touched.

In headless/non-TTY mode, the prompt is skipped and the refactor proceeds
(trusting the caller). A `--dry-run` flag stops after preview (shows the diff
and exits 0).

### 4. Apply — atomic patch

Execute the confirmed `apply_patch`. Because `apply_patch` validates all ops
before writing, a malformed op (e.g. old_string not found because the file
changed between plan and apply) fails atomically — no partial writes.

### 5. Format pass

Reuse `formatFile` + `shouldFormat` from `formatOnEdit.ts`. Iterate over every
file in the applied patch, run the configured formatter. Format failures are
non-fatal — a notice is printed but the refactor is not rolled back.

### 6. Verify + rollback

Run the named check (same classifier-gated path as the solve loop). On pass:
"Refactor complete. 34 files, 72 edits." On failure:

1. `git checkout -- <every changed file>` (restore working tree).
2. `git clean -f <any created files>` (remove new files from the patch).
3. Report: "Refactor failed check '<name>'. Workspace restored. (use --retry
   for iterative fixing)"

The rollback relies on git — the refactor must run in a git repo. If the
workspace is not a git repo, the refactor refuses at the start with an
explicit error (no rollback possible without git).

### 7. Integration with `/refactor` command

The `case "refactor"` handler in `slashCommands.ts` is rewritten to call the
new pipeline instead of `runSolveCommand` directly:

```ts
case "refactor": {
  const parsed = parseRefactorArgs(arg);
  if (!parsed.ok) { /* usage */ return { consumed: true }; }
  if (!runAgent) { /* unavailable */ return { consumed: true }; }

  const result = await runRefactorPipeline(session, {
    checkName: parsed.checkName,
    description: parsed.description,
    dryRun: opts.dryRun,
    retry: opts.retry,
    yes: opts.yes,
  }, runAgent);

  await save();
  return { consumed: true };
}
```

The existing `parseRefactorArgs` and `buildRefactorPrompt` are **kept** (they
remain pure and tested). `buildRefactorPrompt` is reused inside the Plan phase
to seed the model's single planning turn.

The existing `--retry` flag (not yet implemented) is added to `/refactor`
and `/solve` both, defaulting `false` for `/refactor` and `true` for `/solve`.

## Files to change

| File | Change |
|---|---|
| **NEW** `src/cli/refactorPlanner.ts` | `RefactorPlanner` — programmatic discovery from index + grep. Exports `discoverRefactorSites(root, description, index)` → `RefactorPlan`. Pure-ish: takes `index` and `grep` as injectable deps. |
| **NEW** `src/cli/refactorPipeline.ts` | `runRefactorPipeline()` — orchestrates the 6 phases. Takes `Session`, `RefactorPipelineOptions`, and `runAgent`. Phases: discover → plan (single model turn) → preview (TTY prompt or `--yes`) → apply → format → verify → rollback-on-failure. |
| **NEW** `src/cli/refactorPreview.ts` | `renderRefactorPreview(planned)` → string (the diff + confirmation prompt). `confirmRefactor(prompt, {yes, tty})` → boolean. Pure; injectable TTY for tests. |
| **NEW** `src/cli/refactorRollback.ts` | `rollbackRefactor(git, planned)` — `git checkout` changed files + `git clean` created files. Thin wrapper over the existing `Git` class. |
| **EDIT** `src/cli/slashCommands.ts` | Rewrite `case "refactor"` to call `runRefactorPipeline` instead of `runSolveCommand` + `buildRefactorPrompt`. Wire `--dry-run`, `--retry`, `--yes` flags from arg parsing. |
| **EDIT** `src/cli/refactor.ts` | Unchanged (pure helpers stay). Optionally add `extractTargetSymbol(description)` → `string | null` for the planner's symbol-name heuristic. |
| **NOT touched** | `src/solve/solver.ts`, `src/index/*`, `src/tools/applyPatch.ts`, `src/tools/grep.ts`, `src/tools/formatOnEdit.ts`, `src/tools/repoIndexTools.ts`, `src/agent/agentLoop.ts` — all reused as-is. |

## Tests (RED first — commit BEFORE implementation)

### `test/refactor-planner.test.ts`

- **`[planner-symbol-rename]`** — `discoverRefactorSites(root, "rename displayPath to formatPath", index)` returns a plan with `target: "displayPath"`, sites from `findReferences`, `kind: "definition"` for the def site, `kind: "reference"` for call sites. Inject a fake index with known symbols + file contents.
- **`[planner-file-move]`** — description with a file path triggers `impactedBy` and grep for import specifiers. Plan includes the file itself + every importer.
- **`[planner-api-change]`** — "add timeout param to fetchUsers" → `findReferences("fetchUsers")` + grep for `fetchUsers(`. Plan includes definition + call sites.
- **`[planner-empty-result]`** — a symbol not in the index returns a plan with zero sites. Caller (pipeline) refuses with "nothing to refactor."
- **`[planner-truncated]`** — 250 sites; plan returns first 200 with `truncated: true`. No crash.
- **`[planner-no-mutation]`** — the planner never calls any mutate tool; it only reads the index + files. (Assert via a spy on the injected deps.)

### `test/refactor-preview.test.ts`

- **`[preview-renders-diff]`** — given a set of `PlannedOp[]`, `renderRefactorPreview` returns a string containing the unified diff (reuse `planPatch` from `applyPatch.ts`).
- **`[preview-confirm-yes]`** — `confirmRefactor(prompt, {yes: true})` → `true` (no prompt).
- **`[preview-confirm-no-tty]`** — `confirmRefactor(prompt, {yes: false, tty: false})` → `true` (non-interactive defaults to proceed, matching headless behavior). The prompt is still rendered to stdout.
- **`[preview-dry-run]`** — `--dry-run` renders the preview and exits 0 without mutating. (Test via the pipeline with a fake `runAgent` and a fake check.)

### `test/adversarial/refactor-blast-radius.test.ts`

- **`[adversarial-sensitive-path]`** — a planned update op with `path: ".env"` is refused by `apply_patch`'s sensitive-path guard. The pipeline reports the refusal and does NOT proceed to format/verify. No files outside the planned set are touched.
- **`[adversarial-rollback-on-check-failure]`** — inject a check that always fails. After apply succeeds, the verify phase fails → `rollbackRefactor` is called. Assert that `git checkout` was invoked for every changed file and `git clean` for every created file. Assert the pipeline exits non-zero with a message containing "Workspace restored."
- **`[adversarial-no-git-no-refactor]`** — in a non-git workspace, the pipeline refuses at the start with a clear error message before any discovery or mutation.

### Existing tests (must stay green)

- `test/refactor.test.ts` — `parseRefactorArgs` and `buildRefactorPrompt` are unchanged; their tests must pass unchanged.

## Safety / invariants (do not weaken)

- **Read-before-write** — the model MUST read a file before editing it (the Plan phase prompt enforces this; `apply_patch` validates old_string exists, which implicitly proves the file was read since we require `read_file` before `edit_file`/`apply_patch`).
- **Atomic apply** — all ops are validated before any write begins (`planPatch` in `applyPatch.ts`). A single bad op blocks the entire patch.
- **No partial state** — on check failure, the workspace is rolled back to the pre-refactor state via git. There is no "half-refactored" state.
- **Sensitive paths** — `apply_patch` already refuses to touch `.env`, `.git`, `.deepcoder`, etc. The planner also skips sensitive paths during discovery (inherits from grep + index).
- **Bounded discovery** — MAX_SITES = 200, MAX_CONTEXT_LINES = 5 per site. The planner cannot flood the model context.
- **Confirmation gate** — in interactive mode, a human must approve the diff before any mutation. `--yes` is opt-in; the default is "ask."
- **Git required** — the refactor refuses to run outside a git repo (rollback depends on it). This is checked before discovery.
- **Permission model** — all mutations go through the existing classifier gate (apply_patch is a mutate tool; format commands are classifier-gated in `formatFile`). The planner phase is read-only.
- **No model in discovery** — the planner is pure TypeScript, not an LLM call. It cannot hallucinate references.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green with the new tests.
2. Manual acceptance: `/refactor phase rename displayPath to formatPath` in
   deepcoder's own repo — observe:
   - Discovery finds every reference + definition (compare with a manual grep).
   - Preview shows the full diff.
   - Confirmation prompt appears.
   - After `y`, all files are edited atomically.
   - Formatter runs on changed files (if configured).
   - `test:phase` passes (or fails → rollback).
3. Adversarial: `/refactor phase "delete src/tools/grep.ts"` — discovery finds
   all importers; preview shows the blast radius; after confirmation, the file is
   deleted and all importers are updated. Check passes (or fails → rollback).
