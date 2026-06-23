# Feature — Model-callable worktree tools (enter / exit isolation)

## Context

deepcoder already has a full workspace-isolation engine (`src/workspaceIsolation/`):
a disposable git worktree of HEAD where file edits/checks happen, applied back to the
real repo only as a patch (`createGitWorktree` in `gitWorktree.ts:34`, surfaced via
`createIsolatedWorkspace` in `index.ts:19`). Today **only the human drives it** — at
startup via `--workspace-isolation patch` (`setupIsolation` in
`sessionFactory.ts:65`) and at the keyboard via the `/isolation` slash command
(`slashCommands.ts:1237`, sub-verbs `status|diff|apply|discard|path`). The model has
no way to say "do this risky work in a throwaway worktree, then hand me the patch."
Add two native tools — `enter_worktree` / `exit_worktree` — that expose the **existing**
engine to the LLM. We are NOT building a new isolation mechanism; we wire the model to
the one that already ships.

## Model

- `enter_worktree()` — start an isolated worktree for subsequent edits/checks.
  `kind: "session"` (mutates session state, not files). No args (v1 inherits the
  session's `workspaceIsolation` config). Returns the isolated root + a note that the
  real repo is untouched until applied.
- `exit_worktree(action: "apply" | "discard")` — finish isolation: `apply` runs
  `applyPatchToRealRoot({ force: false })` then `cleanup()`; `discard` just
  `cleanup()`. `kind: "session"`. Returns changed-file count / patch outcome.
- Both are **no-ops-with-a-message** when the runtime hook is absent (headless /
  subagent contexts), exactly like `delegate` does when `ctx.delegate` is missing
  (`tools/types.ts:83`, `repl.ts:409`) — never crash.
- These map 1:1 onto `/isolation` verbs: `enter` ≈ `setupIsolation`, `exit apply` ≈
  `/isolation apply`, `exit discard` ≈ `/isolation discard` (`slashCommands.ts:1253`).

## Design

The blocker: isolation lives on the **Session** (`session.isolation`,
`session.executionRoot` — `repl.ts:129-131`), but tools only receive a `ToolContext`
(`tools/types.ts:28`) whose `workspaceRoot` is already resolved to
`executionRoot ?? config.workspaceRoot` (`repl.ts:399`). A tool cannot reach the
session. So follow the **exact** pattern `delegate` uses: a runtime-closure interface
on `ToolContext`, built from the session in `repl.ts`.

### `src/tools/types.ts` — new runtime hook (mirrors `DelegateRuntime`)
```ts
export interface WorktreeRuntime {
  isActive(): boolean;
  enter(): Promise<{ isolatedRoot: string }>;            // throws WorkspaceIsolationError on non-git/dirty
  exit(action: "apply" | "discard"): Promise<{ changed: number; applied: boolean }>;
}
// add to ToolContext: worktree?: WorktreeRuntime;
```

### `src/runtime/sessionFactory.ts` — `buildWorktreeRuntime(session)` (next to `buildDelegateRuntime`, line 222)
Reuse `createIsolatedWorkspace` / `setupIsolation`'s body and `/isolation`'s
apply/discard logic — do NOT reimplement worktree mechanics:
```ts
export function buildWorktreeRuntime(session: Session): WorktreeRuntime {
  return {
    isActive: () => Boolean(session.isolation),
    async enter() {
      if (session.isolation) throw new Error("a worktree is already active");
      const iso = { ...session.config.workspaceIsolation, mode: "patch" as const };
      const ws = await createIsolatedWorkspace(session.config.workspaceRoot, iso);
      session.isolation = ws;
      session.executionRoot = ws.isolatedRoot;   // file tools/checks now target the worktree
      return { isolatedRoot: ws.isolatedRoot };
    },
    async exit(action) {
      const ws = session.isolation;
      if (!ws) throw new Error("no active worktree");
      const changed = (await ws.changedFiles()).length;
      let applied = false;
      if (action === "apply") { await ws.applyPatchToRealRoot({ force: false }); applied = true; }
      await ws.cleanup();
      session.isolation = undefined;
      session.executionRoot = session.config.workspaceRoot;   // back to the real root
      return { changed, applied };
    },
  };
}
```
Wire it in `repl.ts:398` alongside `delegate: buildDelegateRuntime(session)`:
`worktree: buildWorktreeRuntime(session)`.

### `src/tools/enterWorktree.ts` / `src/tools/exitWorktree.ts`
Mirror an existing tool's `Tool → build() → ToolInvocation` shape
(`deleteFile.ts`). `enter_worktree`:
```ts
export const enterWorktreeTool: Tool = {
  name: "enter_worktree", kind: "session", description: "...", schema: z.object({}),
  build(raw) {
    parseArgs("enter_worktree", schema, raw);
    return {
      kind: "session",
      describe: () => "Enter isolated worktree",
      async execute(ctx) {
        if (!ctx.worktree) return { output: "Workspace isolation is unavailable here." };
        if (ctx.worktree.isActive()) return { output: "Already in an isolated worktree." };
        const { isolatedRoot } = await ctx.worktree.enter();
        return { output: `Entered isolated worktree at ${isolatedRoot}. The real repo is untouched until exit_worktree apply.` };
      },
    };
  },
};
```
`exit_worktree` takes `action: z.enum(["apply","discard"])`, calls `ctx.worktree.exit`,
and reports `Applied N file(s)` / `Discarded N change(s)`. Catch
`WorkspaceIsolationError` and return it as `{ output, isError: true }` so the model can
react (e.g. dirty tree → commit/stash first) rather than aborting the turn.

### Registration
Add `enterWorktreeTool`, `exitWorktreeTool` to `NATIVE_TOOLS` in
`src/tools/registry.ts:56`.

## Files to change
- **New:** `src/tools/enterWorktree.ts`, `src/tools/exitWorktree.ts`,
  `test/worktree-tools.test.ts`.
- **Edit:** `src/tools/types.ts` (add `WorktreeRuntime` + `ctx.worktree?`),
  `src/runtime/sessionFactory.ts` (add `buildWorktreeRuntime`),
  `src/cli/repl.ts` (wire `worktree:` into the `ToolContext` at line 398, import it),
  `src/tools/registry.ts` (register both).

## Tests (RED first — integration with a real temp git repo, no mocks)
`test/worktree-tools.test.ts` (use `mkdtemp` + `git init` + a commit, like the
`workspaceIsolation` tests):
- `enter_worktree` with a fake `ctx.worktree` spy → calls `enter()`, output names the
  isolated root; declares `kind: "session"`.
- `enter_worktree` when `ctx.worktree.isActive()` is true → returns "already" message,
  does NOT call `enter()` again.
- `exit_worktree apply` → calls `exit("apply")`; output reports applied count.
- `exit_worktree discard` → calls `exit("discard")`, `applied:false`.
- `exit_worktree` with no active worktree (`isActive=false`/runtime throws) →
  `isError: true` message, turn not aborted.
- `enter_worktree` with `ctx.worktree` undefined → "unavailable" message, no throw.
- End-to-end (real `buildWorktreeRuntime` over a temp git repo): enter → write a file
  via the worktree root → `exit("apply")` lands the change in the real root; a second
  run with `exit("discard")` leaves the real root unchanged. Reuses the live engine.
- Bad `action` (`z.enum`) → `InvalidArgumentsError` from `build()`.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green WITH the new tests.
2. Manual (TUI): ask the agent to "isolate this change" — it calls `enter_worktree`,
   edits run in the worktree, `/isolation diff` shows them, then `exit_worktree apply`
   lands the patch (`/isolation` reports off afterward).

## Safety
- Reuses `createGitWorktree`'s fail-closed guards verbatim: non-git and dirty-tree are
  refused (`gitWorktree.ts:38-49`); `applyPatchToRealRoot` runs `git apply --check`
  before applying so a live-tree change can't be clobbered (`gitWorktree.ts:121-127`).
- `kind: "session"` ⇒ the tools flow through the normal approval gate; `apply` (which
  mutates the real repo) is surfaced via `describe()`/preview so the user sees it.
- No new escape hatch: `enter` only ever points `executionRoot` at a temp worktree;
  `exit` always restores `config.workspaceRoot`. The sandbox/checkpoint interplay is
  unchanged — checkpointing is already disabled while `session.isolation` is set
  (`repl.ts:397`), and that invariant now holds whether the human or the model entered.

## Worker contract notes
- TDD: write the failing `test/worktree-tools.test.ts` cases FIRST. Green `--check
  phase` with ZERO new tests is a vacuous pass.
- REUSE the existing engine — `createIsolatedWorkspace` and the `IsolatedWorkspace`
  methods. Do NOT add git-worktree logic in the tools; they only call the runtime hook.
- The runtime hook MUST be wired into `repl.ts`'s `ToolContext` in the same task —
  a tool that compiles but is never reachable (no `ctx.worktree`) is an inert delegation.
- Pattern to copy exactly: `delegate` (`DelegateRuntime` in `tools/types.ts:83`,
  `buildDelegateRuntime` in `sessionFactory.ts:222`, wired at `repl.ts:409`).
- Related: this is the model-facing twin of the human `/isolation` command; see
  [[feat-file-delete-rename-tools-plan]] for the same Tool→build→ToolInvocation shape.
