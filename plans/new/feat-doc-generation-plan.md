# Feature — Documentation generation (JSDoc + prose-doc update)

## Context

The agent needs to generate JSDoc comments for functions in a user-specified scope
(folder/glob pattern, e.g. `src/utils/**/*.ts`) and then update prose documentation
(README.md) with a high-level summary of a chosen subsystem (e.g. "the new
authentication flow").

This is two capabilities: **per-symbol doc-comment insertion** (read a function
body → understand it → insert a JSDoc block above the declaration) and **prose-doc
section update** (read README → understand the desired topic → add/update a
section). Both are model-driven (the model reads, understands, and writes docs),
but the *machinery* that supports them — scope enumeration, read-before-write
enforcement, idempotency guards — lives in the tool and context layer.

## Design

### Capability 1 — Per-function doc-comment generation

**Pipeline:** scope → enumerate symbols → for each un-documented function: read its
body → generate JSDoc → insert block above the symbol line.

**Scope selection** reuses the existing repo-index stack (`src/index/`):

- `glob` tool (`src/tools/glob.ts`) returns files matching a pattern.
- `buildRepoIndex` (`src/index/scanner.ts`) + `extractSymbols`
  (`src/index/symbols.ts`) enumerate function/class/const definitions with line
  numbers — already working, regex-based, TS/JS + Python.
- `findReferences` (`src/index/references.ts`) can confirm a symbol is a
  definition (not just a mention).

**The agent drives the loop** — no new tool is strictly required. The existing
tools (`glob`, `read_file`, `grep`, `edit_file`) are sufficient:

1. `glob "src/utils/**/*.ts"` → file list.
2. For each file, `read_file` to see function bodies and check for existing doc
   blocks.
3. For each un-documented function, `edit_file` to insert a `/** ... */` JSDoc
   block ABOVE the function declaration.

**Idempotency** is critical — re-running must not duplicate doc blocks. The agent
must check for an existing comment block immediately above the function before
inserting. A `grep` for `/**` on the 1–4 lines preceding the symbol's line is the
cheapest pre-check.

### Capability 2 — Prose-doc section update (README)

The agent reads `README.md`, understands a requested topic (e.g. "authentication
flow"), and inserts or replaces a Markdown section with a human-readable summary.

- `read_file "README.md"` → full content.
- `edit_file` inserts/replaces a `## Authentication flow` section.
- Section boundary detection: look for `## ` headers; insert before/after the
  right neighbor, or append before a known sentinel (e.g. `## Architecture`).

### What does NOT need new code

The existing tool surface already covers everything required:

| Step | Existing tool |
|------|--------------|
| Enumerate files in scope | `glob`, `list_dir` |
| Enumerate symbols with line numbers | `repo_map`, `find_symbols` |
| Read function bodies | `read_file` |
| Check for existing doc blocks | `grep` (or `read_file` a small window) |
| Insert JSDoc block | `edit_file` (exact-string replacement) |
| Insert/update README section | `edit_file` |

**No new tools are needed.** The feature is a *capability demonstration* — the
agent uses the existing tool surface to perform documentation generation.

However, the **tests** require a new test file because we want to prove
idempotency and the "never mutate executable code" invariant programmatically.

## Files to change

| File | Change | Why |
|------|--------|-----|
| `test/doc-generation.test.ts` | **NEW** — adversarial + unit tests | Prove doc-block insertion, idempotency (no duplicate blocks), executable-code invariance, README section insertion |
| (No production code changes) | — | The existing tool surface is sufficient |

## Tests (RED first)

Doc-block insertion is unit-testable — we can test the agent's edit patterns
without a live model.

### `test/doc-generation.test.ts`

```typescript
// Test 1 — detect existing JSDoc block above a function (idempotency guard)
//   Given a file with "/** existing */\nfunction foo() {}", verify a grep for
//   "/**" on the 2 lines above foo's declaration matches.

// Test 2 — insert JSDoc above an un-documented function
//   Given "function bar(x: number): string {", use edit_file to insert a
//   "/** ... */\n" block ABOVE. Verify the result compiles (has the same AST
//   shape — executable code unchanged).

// Test 3 — re-run is idempotent (no duplicate blocks)
//   Run insertion twice on the same file. Verify only ONE JSDoc block exists
//   above the function.

// Test 4 — executable code invariance
//   Take a file with functions, insert doc blocks above every one, run
//   `tsc --noEmit` on the result. Must be green. Compare AST before/after
//   (function bodies, signatures, exports unchanged).

// Test 5 — README section insertion
//   Given a README with sections "## Setup", "## Usage", insert a new section
//   "## Authentication flow" between them. Verify:
//   - Section header is present exactly once.
//   - Existing sections are unmodified.
//   - Re-run does not duplicate the section.

// Test 6 — README section replacement
//   Given a README with an existing "## Authentication flow" section, replace
//   its body. Verify old content is gone, new content is present, header
//   appears exactly once.

// Test 7 — glob scope filtering
//   Given a tmp dir with `src/utils/a.ts`, `src/utils/b.ts`, `src/other/c.ts`,
//   verify glob "src/utils/**/*.ts" returns only a.ts and b.ts.

// Test 8 — adversarial: doc block cannot change executable code
//   Inserting a comment must not alter any line below the insertion point
//   (byte-for-byte comparison of everything after the last inserted line).
```

The test file uses the project's existing test harness (`node:test` +
`node:assert/strict`), and operates on temp directories via `mkdtemp`.

### RED anchor

Before any implementation, commit this test file with `test.skip(...)` or
`test.todo(...)` wrappers so it's red on baseline:

```bash
npm run test:phase  # green — all tests skipped
# Then unwrap one test → red → implement → green → repeat
```

## Safety invariants

1. **Only comments/docs change — NEVER executable code.** The `edit_file` tool
   inserts text ABOVE function declarations, before any executable line. The
   agent MUST NOT modify function bodies, signatures, or any line below the
   declaration. Test 4 (tsc + AST compare) proves this.

2. **Typecheck + test:phase stays green.** Every doc-block insertion is a
   comment-only change; the TypeScript compiler ignores comments. But we verify:
   - `npm run typecheck` passes after insertion.
   - `npm run test:phase` passes (existing tests unaffected).

3. **Re-runs are idempotent.** Before inserting, the agent checks for an existing
   `/**` comment in the 1–4 lines above the symbol. If found, it skips. Tests 1
   and 3 prove this.

4. **Scope is explicit.** The user provides a folder path or glob pattern. The
   agent never guesses the scope — it always resolves via `glob` first.

5. **Read-before-write enforced.** The `edit_file` tool already refuses edits on
   files that haven't been read this session (`readTracker`). No change needed.

6. **README section boundaries are explicit.** Section insertion uses existing
   `## ` headers as anchors. The agent never inserts in the middle of a section.
   Insertion points are always: before a specific header, after a specific
   header, or at end-of-file.

## Edge cases / failure modes

| Scenario | Handling |
|----------|----------|
| Function has no room above (line 1) | Insert at line 1, pushing the function down. doc comment IS the first line. |
| Function already has a JSDoc block | Skip (idempotency check via grep for `/**` above). |
| Function has a single-line `//` comment above | Treat as undocumented; insert `/** */` block above the `//` line. Existing `//` stays. |
| README has no `## ` headers | Append new section at end of file. |
| Requested README section already exists | Replace its body (from header to next `## ` or EOF). |
| Glob matches 0 files | Agent reports "no files in scope" and stops. |
| File is >1 MB or binary | `read_file` already refuses; agent skips. |
| Symbol extraction misses a function (regex gap) | Acceptable — the regex-based symbol extractors (`src/index/symbols.ts`, `src/context/repoMap.ts`) are "good enough to guide search, not a compiler." |

## Work plan

1. **Create `test/doc-generation.test.ts`** with all 8 tests in `test.todo(...)`
   form. Commit as the RED anchor. `test:phase` stays green.

2. **Unwrap test 7 (glob scope) first** — it exercises existing `glob` tool
   behavior only. Prove it passes.

3. **Unwrap tests 1–4 (doc-block insertion) one by one**, implementing the
   agent-side patterns (grep-for-existing, edit_file insertion) in test
   assertions. Each test exercises the *exact edit_file call pattern* the agent
   would use.

4. **Unwrap tests 5–6 (README section)**, proving section insertion and
   replacement via `edit_file`.

5. **Unwrap test 8 (adversarial)** last — it's the strongest invariant and
   depends on patterns from 1–4 working correctly.

6. **Final gate:** `npm run test:phase` green, all 8 tests passing, no production
   code changed.

## Non-goals (explicitly out of scope)

- A new `doc_generate` tool — the existing tool surface is sufficient.
- A new `write_docs` slash command.
- Automatic doc generation on every edit (no hook).
- Generating docs for languages other than TS/JS (the symbol extractors handle
  Python too, but JSDoc is TS/JS-only by definition; Python docstrings are
  deferred).
- Generating docs for `const` arrow functions (only `function` and `class`
  declarations in v1; arrow-function JSDoc placement is semantically ambiguous
  and less valuable).
- Model-callable doc generation (the agent drives this reactively when asked, not
  via a structured tool call).
