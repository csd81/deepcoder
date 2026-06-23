# Feature — Repo refactoring (`/refactor`)

> **This plan was rewritten after an assessment against the codebase.** The
> original draft's execution design — a `runSolveLoop(session, { contextMessages,
> strategy: "apply_patch-first", … })` call — does not match the real solver API
> and double-counted context-gathering the solver already does. The intent
> (analyze → plan → execute → verify in one command) is kept; the wiring is
> corrected to ride the *existing* `/solve` plumbing. See **Appendix A** for the
> assessment.

## Context

deepcoder can edit single files (`edit_file`), apply multi-file atomic patches
(`apply_patch`: `create` / `update` / `delete` ops), and iterate against a check
(`/solve` → `runSolveLoop`). Cross-file refactoring is still manual. The pieces
to automate it already exist:

- **Impact data** lives in `src/index/` — `impact.ts` (who imports a symbol),
  `references.ts` (all references), `symbols.ts`, `imports.ts`. It's also exposed
  to the model as the `impact_graph`, `find_references`, `repo_index`, and
  `repo_map` **tools**, which the model can call mid-loop.
- **The edit→check→retry loop** is `runSolveLoop(session, opts, deps)`
  (`src/solve/solver.ts`), driven by `runSolveCommand` (`src/cli/solveRunner.ts`),
  which wires the `SolveDeps` (runAgent + lifecycle hooks).
- **Preflight context** already exists: when `config.context.preflight` is on,
  `solveRunner` runs an explorer subagent before attempt 1 and injects a brief
  into `session.messages` (`solveRunner.ts:144-164`).

So `/refactor` is **not a new engine** — it is `/solve` seeded with
refactor-oriented context and a prompt that steers toward an atomic
`apply_patch`. The work is a thin command wrapper, not a new solver.

## Model

- `/refactor <check-name> <description>` — mirrors `/solve`'s arg shape (the
  check is required because the solver verifies against a named, classifier-gated
  check; it refuses with neither a check nor `repro:auto`). Gathers refactor
  context, seeds it, then runs the existing solve loop against `<check-name>`.
- The model is steered (via a seeded system message) to use `impact_graph` /
  `find_references` to find every affected site and to emit a single
  `apply_patch` covering all of them. This is a *nudge*, not an enforced
  strategy — the solver cannot force a particular tool.
- On check failure the existing loop feeds back a redacted summary and retries up
  to `maxAttempts` (same as `/solve`).

## Design

### 1. Refactor context (reuse preflight; add impact only if it pays)

**Default:** rely on the existing preflight explorer + the model's own
`impact_graph` / `find_references` tools. Do **not** hand-roll a bounded
`RefactorContext` snapshot first — a pre-baked top-20/top-50 list can be stale or
clip the very reference the refactor needs, and the model can query the live
index itself.

**Optional refactor-specific seed:** if a symbol name is parseable from the
description, build a small, explicit impact block directly from the index and
inject it as a system message (mirroring the preflight injection at
`solveRunner.ts:159`):

```ts
// src/cli/refactor.ts
import { findReferences } from "../index/references.js";
import { impactedBy } from "../index/impact.js";

export function buildRefactorSeed(symbol: string, refs: Reference[], impacted: string[]): string {
  // A SHORT, explicit "here are the known reference sites; verify with the
  // tools before editing" block — advisory, not authoritative.
}
```

Seed via `session.messages.push({ role: "system", content: seed })` before
invoking the loop — the same mechanism preflight uses. There is no
`contextMessages` option on the solver.

### 2. Execute via the existing solve wiring

`/refactor` calls the **same** `runSolveCommand` that `/solve` uses — it does NOT
call `runSolveLoop` directly (that needs the full `SolveDeps` wiring, which
`runSolveCommand` owns). The real options shape is `SolveOptions`
(`src/solve/types.ts`): `{ task, checkName?, maxAttempts, repro?, reproPath? }` —
no `strategy`, no `contextMessages`.

```ts
// src/cli/slashCommands.ts — mirror `case "solve"` (line ~1283)
case "refactor": {
  const [checkName, ...rest] = arg.split(/\s+/);
  const description = rest.join(" ").trim();
  if (!checkName || !description) {
    console.log(chalk.dim("usage: /refactor <check-name> <description>"));
    return { consumed: true };
  }
  if (!runAgent) {
    console.log(chalk.red("Refactor is unavailable in this context."));
    return { consumed: true };
  }
  // Seed refactor-oriented context (preflight already runs inside runSolveCommand
  // when enabled; this adds the apply_patch / impact-tool nudge + any symbol seed).
  session.messages.push({ role: "system", content: buildRefactorPrompt(description) });
  await runSolveCommand(
    session,
    { task: `Refactor: ${description}`, checkName, maxAttempts: config.solveMaxAttempts },
    runAgent,
  );
  await save();
  return { consumed: true };
}
```

`buildRefactorPrompt` is the steering message: "use impact_graph/find_references
to find ALL sites, then apply them as a single apply_patch; verify nothing else
changed." Keep it short — it rides the cached prefix only for this run.

### 3. Register in the catalog

Add one entry to `SLASH_CATALOG` in `src/cli/slashCatalog.ts` (metadata only — the
executor stays the `handleSlashCommand` switch):

```ts
{ name: "refactor", args: "<check-name> <description>",
  description: "Cross-file refactor: gather impact, edit atomically, verify against a check",
  category: "session" },
```

### 4. No solver changes

`runSolveLoop` is reused as-is. There is **no** `apply_patch-first` strategy to
add — the solver runs the agent, which picks tools; steering happens in the
seeded prompt. Dropping the original plan's `src/solve/solver.ts` edit.

## Files to change

- **New:** `src/cli/refactor.ts` (`buildRefactorPrompt`, optional `buildRefactorSeed`),
  `test/refactor.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "refactor"`, mirroring `case "solve"`),
  `src/cli/slashCatalog.ts` (one `SLASH_CATALOG` entry).
- **Not touched:** `src/solve/solver.ts` (no strategy needed), `src/index/*` (read
  via existing exports only).

## Tests

- `buildRefactorPrompt` produces a bounded steering message naming the impact
  tools and the atomic-patch expectation.
- `buildRefactorSeed` (if built) turns index `findReferences` / `impactedBy`
  output into a short, explicit block and never exceeds its byte budget.
- `/refactor` with a missing check-name or description prints usage and does not
  invoke the loop.
- The `SLASH_CATALOG` entry exists and matches the real command (there is likely
  an existing catalog-vs-switch consistency test — extend it).
- End-to-end (temp repo, configured check): `/refactor <check> rename X to Y` →
  references updated in one patch, check passes. NOTE: needs a configured check;
  pick the harness's existing solve E2E fixture as the template.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: `/refactor <check> rename displayPath to formatPath` in deepcoder's own
   repo. **Prereq:** a check named `<check>` must exist in `config.checks` (e.g.
   wire `test:phase` as a named check first), or the solver refuses.

## Safety

- All edits go through the existing permission gate (apply_patch is a mutate tool).
- Reuses the solve loop's guarantees: bounded attempts, redacted failure
  feedback, classifier-gated checks (the check is looked up by name, never
  model-chosen), no auto-rollback.
- Index reads are read-only; the seeded impact block is advisory — the model must
  still verify with tools before editing.

---

## Appendix A — assessment of the original draft

Verified against the code; the goal is sound but the execution was fictional.

1. **`runSolveLoop(session, { task, contextMessages, check, strategy, maxAttempts })`
   does not exist.** Real signature: `runSolveLoop(session, opts, deps)`
   (`solver.ts:84`). `SolveOptions` (`types.ts:19`) is
   `{ task, checkName?, maxAttempts, repro?, reproPath? }` — no `contextMessages`,
   no `strategy`, and `check` is `checkName`. `deps` (`SolveDeps`, ~9 fields incl.
   `runAgent`) must be wired; `runSolveCommand` (`solveRunner.ts`) owns that. A
   command calls `runSolveCommand`, like `case "solve"` does.

2. **No `strategy: "apply_patch-first"`.** The solver runs the agent loop; the
   model chooses tools. You can only nudge via the seeded prompt.

3. **The solver refuses without a check or `repro:auto`** (`solver.ts:109-115`).
   `/refactor <description>` with no check would refuse. Hence the required
   `<check-name>` arg, mirroring `/solve`.

4. **The "Analysis phase" duplicates existing work.** A Phase 8D preflight
   already runs an explorer and injects a brief into `session.messages`
   (`solveRunner.ts:144-164`), and `impact_graph` / `find_references` /
   `repo_index` are already model-callable tools. A bespoke bounded
   `RefactorContext` (top-20/top-50) risks staleness and clipping the needed
   reference — prefer the live tools, seed only a short advisory block.

5. **Context is seeded by pushing a message, not by a `contextMessages` option** —
   exactly what preflight does at `solveRunner.ts:159`.
