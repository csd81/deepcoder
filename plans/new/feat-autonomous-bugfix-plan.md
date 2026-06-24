# Feature — Autonomous bug-fix & commit (`deepcoder bugfix`)

## Context

Today, fixing a bug end-to-end takes a human stitching steps:
1. create a branch (`git checkout -b fix-auth-bug`)
2. search the codebase for the relevant logic
3. run `/solve --check phase "fix the login token storage bug"` (closed-loop edit→check→retry)
4. self-review: `git diff` to see what changed
5. `git add` + `git commit` with a sensible message

The pieces to automate this **already exist** but are not chained into a single command:

| Manual step | Already-built primitive |
|---|---|
| create branch | `Git.createBranch()` in `src/workspace/git.ts:217` |
| search codebase for relevant logic | `src/index/` (repo index + symbols), `src/tools/grep.ts` (ripgrep tool) |
| fix loop (edit → check → retry) | `runSolveLoop` in `src/solve/solver.ts:84` — the closed-loop solver |
| self-review (`git diff`) | `Git.diff()` in `src/workspace/git.ts:58` — read-only, already used for telemetry snapshots |
| commit | **NOT safe to expose to the agent** — see permission analysis below |

**Key gap:** there is no single command that creates the branch, runs the fix loop,
reviews the diff, and commits — with the commit step correctly **gated as a trusted
deterministic action** (not an ungated agent `run_bash`).

### Overlap with `delegate auto`

`delegate auto` (`src/cli/delegateCli.ts:491`) chains plan → run (isolated worktrees) →
validate (9 gates) → PR. It is designed for **multi-worker decomposed tasks with TDD**.
`bugfix` is the **single-branch, simpler sibling**:
- No decomposition (one fix, one branch)
- No TDD requirement (the configured check is the oracle, no red-seed gate)
- Commits directly (no PR) — suitable for small, targeted fixes on a feature branch
- Shares the solve loop (`runSolveLoop`) and the validation pattern (gated commit)
- Does NOT share the delegation plan/worker machinery

## Permission model — the commit gate

### Why the agent cannot commit via `run_bash`

The command classifier (`src/permissions/commandMatrix.ts`) only allows read-only git
subcommands: `status`, `diff`, `log`, `show` (line 53). `git commit`, `git checkout`,
`git add` are **not** in `READ_ONLY_GIT`, so they classify as `"ask"`.

In `checkPermission` (`src/permissions/policy.ts:41-49`):
- `mode === "auto"` + classified `"ask"` → returns `"ask"`
- In headless/non-TTY mode, the approval step auto-denies `"ask"` (no TTY to answer)

**Confirmed: a headless agent CANNOT `git commit`/`git checkout`/`git add` via `run_bash`.**

This is correct and must stay. The commit step must be a **trusted, deterministic action**
in the orchestration layer — mirroring how `prepareWorkerBranch` (`src/delegate/openPr.ts:88`)
calls `git commit` via direct `execFile`, never through the agent loop.

### Design: commit as a gated orchestration step

The commit is gated on:
1. **`runSolveLoop` returns `solved: true`** — the configured check passed
2. **Working tree is dirty** — `git status --porcelain` shows changes
3. **Commit message is sensible** — either auto-generated from the task or user-provided

The commit itself runs via `Git.commit()` (the workspace helper, not the agent) — the
same path the interactive `/commit` slash command uses. This is safe because:
- The fix is verified (check passed)
- The diff is deterministic (we can review it before committing)
- The commit message is bounded and sanitized

## Design

### New CLI surface

```
deepcoder bugfix "<task>" [--branch <name>] [--check <name>] [--message <msg>]
                           [--max-attempts <n>] [--no-commit] [--json]
```

**Flow:**
1. **Create branch** (`--branch` or auto-derived from the task, e.g. `fix-auth-bug` →
   `fix/auth-bug`) — uses `Git.createBranch()` directly (not through the agent)
2. **Bug localization** — run a read-only preflight explorer (`src/subagents/contextExplorer.ts`,
   already used by `runSolveCommand` for `session.config.context.preflight`) to identify
   the relevant files and inject them as context
3. **Fix loop** — `runSolveLoop(session, opts, deps)` with the configured check.
   This IS the existing solve loop — no new fix logic. The check is the success oracle.
4. **Self-review** — after a green check, run `Git.diff()` and inject it into the
   session so the agent can produce a commit message summarizing the change
5. **Commit (gated)** — only if `solved: true` AND working tree is dirty AND
   `--no-commit` is not set. The commit message is:
   - `--message <msg>` if provided
   - Otherwise, ask the agent to summarize the diff into a conventional-commit message
     (one constrained turn, no file edits — message only)
   - Fallback: `fix: ${task truncated to 72 chars}`

### New file: `src/cli/bugfixRunner.ts`

Orchestration module (analogous to `src/cli/solveRunner.ts` but adds branch +
commit steps). Pure-ish: git operations via injected `Git` instance; solve loop
via `runSolveLoop`. Testable with fakes.

```ts
export async function runBugfix(
  session: Session,
  opts: BugfixOptions,
  runAgent: () => Promise<void>,
): Promise<BugfixResult>;
```

Where:
```ts
interface BugfixOptions {
  task: string;
  branch?: string;        // auto-derived if absent
  checkName?: string;     // defaults to "phase" if configured
  maxAttempts: number;    // default 5
  message?: string;       // manual commit message override
  noCommit?: boolean;     // skip commit, just fix
  json?: boolean;         // machine-readable output
}

interface BugfixResult {
  branch: string;
  solved: boolean;
  solveResult: SolveResult;
  committed: boolean;
  commitHash?: string;
  commitMessage?: string;
}
```

### New CLI command: `src/cli/bugfixCli.ts`

Registers `deepcoder bugfix` on the commander program (like `registerDelegateCommand`).

### Files to touch

| File | Change |
|---|---|
| `src/cli/bugfixRunner.ts` | **NEW** — orchestration: branch → preflight → solve → review → commit |
| `src/cli/bugfixCli.ts` | **NEW** — CLI registration for `deepcoder bugfix` |
| `src/cli/main.ts` | Register the new command |
| `src/solve/types.ts` | Add `BugfixOptions` / `BugfixResult` types (or keep in bugfixRunner) |
| `src/workspace/git.ts` | Possibly add `diffStat()` for a summary diff view (optional) |

### Reused (zero changes)

| Module | Role |
|---|---|
| `src/solve/solver.ts` | `runSolveLoop` — the closed-loop fix engine |
| `src/solve/types.ts` | `SolveOptions`, `SolveResult`, `SolveAttempt` |
| `src/solve/failureSummary.ts` | `summarizeCheckFailure`, `buildRetryPrompt` |
| `src/solve/repro.ts` | Repro-test generation (opt-in via `--repro auto`) |
| `src/subagents/contextExplorer.ts` | Preflight bug-localization (already used by `runSolveCommand`) |
| `src/permissions/commandClassifier.ts` | Classifier — unchanged, continues to deny `git commit` for agents |
| `src/permissions/policy.ts` | Permission gate — unchanged |
| `src/workspace/git.ts` | `Git` class — `createBranch`, `diff`, `commit`, `changedFiles` |
| `src/delegate/` | **Untouched** — `bugfix` is the simple sibling, not a delegate variant |

## Safety invariants

1. **Branch creation is gated** — `Git.createBranch()` runs in the orchestrator, not
   through the agent loop. Fail-closed: if the branch name is unsafe (contains `/`,
   `..`, shell metacharacters), refuse.

2. **The fix loop is the existing solve loop** — no new check-running, no new
   permission bypass. The configured check is classified before running (existing
   gate in `runSolveLoop` lines 102-108).

3. **Commit is gated on `solved: true`** — a red check means no commit, period.
   This mirrors how `delegate auto` gates PR on `applyable`.

4. **Commit is NOT an agent `run_bash`** — it's a direct `Git.commit()` call in the
   orchestrator. The agent never runs `git commit`. The command classifier's deny
   of `git commit` for headless agents is preserved and not bypassed.

5. **Working tree must be dirty** — if the agent didn't actually change any files
   (vacuous fix), refuse to commit (empty commits are noise).

6. **Commit message is bounded** — max 72-char subject line, no shell metacharacters.
   If the agent generates the message, it's one constrained turn (no file edits).

7. **No force-push, no amend, no rebase** — `bugfix` only creates a branch and
   commits on it. Never touches remote.

8. **Isolation-aware** — if workspace isolation is active (`session.isolation`),
   refuse to create a branch or commit (same guard as `gitSlashCommands.ts:31-37`).

## Tests (RED first)

### Unit tests (`src/cli/bugfixRunner.test.ts`)

1. **`bugfix creates a branch`** — with a fake `Git`, verify `createBranch` is called
   with the expected name
2. **`bugfix refuses unsafe branch names`** — names with `..`, absolute paths, shell
   metacharacters → error, no branch created
3. **`bugfix runs solve loop with the task`** — fake `runSolveLoop` → verify it's
   called with the task and check name
4. **`bugfix commits when solved + dirty`** — fake `runSolveLoop` returns
   `solved: true`, fake `Git.changedFiles()` returns non-empty → `Git.commit()` is
   called
5. **`bugfix does NOT commit when not solved`** — fake `runSolveLoop` returns
   `solved: false` → `Git.commit()` is never called
6. **`bugfix does NOT commit when tree is clean`** — fake `solved: true` but
   `changedFiles()` returns empty → no commit, result reflects this
7. **`bugfix respects --no-commit`** — `solved: true`, dirty tree → no commit
8. **`bugfix auto-generates commit message from task`** — no `--message` → message
   derived from task
9. **`bugfix uses explicit --message when provided`**
10. **`bugfix refuses under workspace isolation`** — `session.isolation` is set →
    error, no branch, no commit

### Integration / adversarial

11. **End-to-end with a real git repo** — create a temp repo with a failing test,
    run `bugfix` → branch exists, commit exists, test passes on the branch
12. **Agent cannot `git commit` via `run_bash`** — verify the command classifier
    still denies `git commit` (this is a property of the existing classifier,
    but worth an explicit regression test)

## Implementation order

1. **RED: Write the test file** `src/cli/bugfixRunner.test.ts` with the 10 unit
   tests above — all red (no implementation yet)
2. **Write `src/cli/bugfixRunner.ts`** — pure orchestration with injected seams
3. **Write `src/cli/bugfixCli.ts`** — CLI registration
4. **Wire into `src/cli/main.ts`**
5. **GREEN: All tests pass**
6. **Manual acceptance:** `deepcoder bugfix "fix the off-by-one in pagination" --check phase`
   on a real repo with a known bug

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent generates a garbage commit message | Message is bounded to 72 chars; `--message` override available; fallback uses the task text |
| Branch name collision | Append a short unique suffix if the branch already exists |
| Agent edits files outside the workspace | Existing path guards in edit tools prevent this |
| Check is a destructive command | `runSolveLoop` already classifies the check command and refuses if `"deny"` |
| Agent tries to self-commit via `run_bash` | Command classifier denies it; the agent gets a tool error, not a shell |
