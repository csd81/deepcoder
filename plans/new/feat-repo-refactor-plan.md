# Feature — Repo refactoring (`/refactor`)

## Context

Deepcoder can edit individual files (`edit_file`) and atomic multi-file patches (`apply_patch`), and has a solve loop (`/solve`) for iterating against a check. But cross-file refactoring — renaming a symbol, extracting a module, restructuring an API — is still manual: the user must identify all affected files, apply changes one by one, and verify.

The repo index (`src/index/`) already tracks symbol definitions, references, import edges, and impact graphs. The `apply_patch` tool handles multi-file atomic edits. The solver handles iterative check-against. What's missing is a workflow that ties them together: **analyze → plan → execute → verify** in one command.

## Model

- `/refactor <description>` — analyses the codebase, identifies all files affected by the refactor, produces an `apply_patch` plan, executes it, and runs verification (typecheck + tests).
- `/refactor --check phase` — like `/solve`, runs a named check after applying the refactor.
- The model sees the impact graph (which files import the symbol being changed), the current definitions, and all references. It produces a single `apply_patch` payload covering all changes.
- If compilation or tests fail, the model gets one retry with the error output (same as `/solve`).

## Design

### 1. Analysis phase

Before the model plans edits, gather context:

```ts
export interface RefactorContext {
  task: string;
  // Derived from the repo index
  affectedFiles: string[];
  symbols: { name: string; file: string; kind: string }[];
  references: { symbol: string; file: string; line: number }[];
  impact: { file: string; impactedBy: string[] }[];
}
```

Built from the existing `impactedBy`, `findReferences`, and `repo_index` tools. The context is bounded (top 20 files, top 50 references) to fit the prompt.

### 2. `apply_patch` + solve loop

The refactor uses the existing solve loop infrastructure from `src/solve/solver.ts`, but:
- The initial edit is an `apply_patch` call instead of individual edits
- The model gets the refactor context (impact graph + references) as a system message
- On check failure, the model can emit additional `apply_patch` or individual edits as retries

### 3. Slash command (`/refactor`)

```ts
case "refactor": {
  const task = arg.trim();
  if (!task) { console.log(chalk.red("Usage: /refactor <description>")); return { consumed: true }; }

  // 1. Gather refactor context from the index
  const ctx = await gatherRefactorContext(config.workspaceRoot, task);

  // 2. Build a system message with the impact context
  const contextMsg = buildRefactorContextMessage(ctx);

  // 3. Run the solve loop with a combined apply_patch strategy
  const result = await runSolveLoop(session, {
    task,
    contextMessages: [contextMsg],
    check: "phase",                          // or user-specified
    strategy: "apply_patch-first",           // prefer atomic patch over individual edits
    maxAttempts: 3,
  });

  // 4. Show summary
  const changed = result.changedFiles ?? [];
  console.log(chalk.green(`Refactor complete. ${changed.length} file(s) changed.`));
  if (result.solved) console.log(chalk.dim("All checks passed."));
  else console.log(chalk.yellow("Refactor applied but checks failed. Review with /diff."));
  return { consumed: true };
}
```

### 4. Reuse existing solver

The `runSolveLoop` in `src/solve/solver.ts` already handles edit→check→retry cycles. The refactor command just seeds it with richer context and a strategy hint. No new solver needed — wire the existing one.

## Files to change

- **New:** `src/cli/refactor.ts`, `test/refactor.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "refactor"`), `src/cli/slashCatalog.ts`, `src/solve/solver.ts` (optional: add apply_patch-first strategy).

## Tests

- `gatherRefactorContext` queries the index and returns affected files + references.
- `buildRefactorContextMessage` produces a bounded, structured context block.
- Solve loop with `strategy: "apply_patch-first"` emits `apply_patch` on the first turn.
- End-to-end (temp repo): `/refactor rename function X to Y` → all references updated, typecheck passes.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: in deepcoder's own repo, `/refactor rename displayPath to formatPath` → index detects all references, model renames them in one atomic patch, typecheck passes.

## Safety

- All edits go through the existing permission gate (same as any mutate tool).
- Reuses the existing solve loop — bounded attempts, redacted failure feedback, classifier-gated checks.
- Impact context is read-only (from the repo index). Never mutates without explicit approval.
