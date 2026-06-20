# Deepcoder Phase 9H - Delegated Worker Workspace Isolation Defaults

## Context

Phase 7D introduced workspace isolation as a general CLI safety layer: run the
agent in a disposable worktree/copy, collect a patch, and apply only after
explicit review.

Phase 9 internalizes the delegated-worker workflow. Workers are now Deepcoder
subprocesses that can implement slices of a plan, and the parent process reviews
their output before apply. That makes workspace isolation more important than in
ordinary one-shot use: delegated workers should never mutate the live checkout
directly.

The current worker-runner architecture is already mostly right:

- `src/delegate/workerRunner.ts` creates an isolated worktree that the runner owns.
- The child runs with `DEEPCODER_WORKSPACE_ISOLATION=off` because it is already
  inside that runner-owned worktree.
- The runner extracts a patch and changed files from the worktree.
- `src/delegate/apply.ts` is the only path that applies a patch to the real repo.

Phase 9H turns that architecture into an explicit product invariant with tests,
status visibility, and fail-closed guards.

## Goal

Delegated workers edit only isolated workspaces by default and by construction.
The live repo changes only through the reviewed apply path.

```text
real repo
  -> runner-owned isolated worktree
  -> worker edits/checks there
  -> patch artifact + log + run record
  -> parent review
  -> explicit apply or discard
```

## Non-Goals

- Do not make ordinary `deepcoder "task"` workspace isolation default.
- Do not add auto-apply.
- Do not run multiple workers in parallel.
- Do not replace Phase 9C patch validation.
- Do not add Docker/container isolation; this is git-worktree/copy workspace
  isolation.

## Invariants

1. `/delegate run` always uses a parent-owned isolated workspace.
2. The delegated child process never receives the real repo as `cwd`.
3. The delegated child receives `DEEPCODER_WORKSPACE_ISOLATION=off` only because
   the parent already isolated the workspace.
4. The real repo must remain unchanged after `/delegate run`, regardless of
   worker success/failure/timeout.
5. A worker patch can reach the real repo only through `/delegate apply`.
6. Non-TTY apply remains refused.
7. Dirty real repo still fails closed unless a future explicit, tested dirty-diff
   replay mode is implemented.
8. The run record must make isolation auditable: backend, isolated root if kept,
   cleanup status, patch path, changed files.

## User Experience

### `/delegate run`

Running a worker prints the isolation boundary:

```text
delegate worker: worker-2
workspace isolation: git-worktree
isolated root: /tmp/deepcoder-ws-abc123/wt
live repo: /0/deepcode/deepcoder
apply policy: patch only; no live edits
```

On completion:

```text
worker passed check
changed files:
  src/foo.ts
  test/foo.test.ts
patch: .deepcoder/delegations/<plan>/runs/<worker>/patch.diff

Review with:
  /delegate review <plan-id> <worker-id>
Apply with:
  /delegate apply <plan-id> <worker-id>
```

### `/delegate status`

Show isolation state per worker:

```text
worker   status   iso          patch   changed
w1       passed   cleaned      yes     2
w2       failed   kept:/tmp/... yes     1
```

### `/delegate review`

Include:

- patch path,
- changed files,
- isolation backend,
- whether the worktree was cleaned or kept,
- explicit line: `live repo was not modified by this run`.

### `/delegate discard`

Discard means:

- delete patch/log/run artifacts for the worker or mark them discarded,
- remove kept worktree if still present,
- never touch live source files.

## Data Model

Extend `WorkerRun` with optional isolation metadata:

```ts
interface WorkerIsolationRecord {
  backend: "git-worktree" | "copy";
  mode: "runner-owned";
  realRoot: string;
  isolatedRoot: string | null;
  kept: boolean;
  cleaned: boolean;
  cleanupError?: string;
}
```

Add to `WorkerRun`:

```ts
isolation?: WorkerIsolationRecord;
```

This is optional for backward compatibility with existing run records.

Privacy note: `isolatedRoot` is a local temp path. It is useful for audit and
manual inspection when `keepWorktree` is enabled. It should appear only in local
`.deepcoder/delegations/...` records and CLI output, never in model prompts.

## Implementation

### 1. Make the invariant explicit in `workerRunner`

Current behavior already creates the isolated workspace. Strengthen it:

- rename local comments from "standard config" to "delegated worker isolation",
- force `workspaceIsolation.mode` to `keep` or `patch` at the parent runner level
  regardless of any user config that would otherwise disable isolation,
- reject any `isolationConfig.mode === "off"` passed into `runWorker`,
- keep child env forced to `DEEPCODER_WORKSPACE_ISOLATION=off`.

Reason: user config may disable normal CLI isolation, but delegated workers have a
stricter default. Worker isolation is part of the delegation safety boundary, not
an optional user preference.

### 2. Record isolation metadata

In `runWorker`:

- record backend and isolated root after `createIsolatedWorkspace`,
- record cleanup success/failure in the final `WorkerRun`,
- if `keepWorktree` is false and cleanup succeeds, store `isolatedRoot: null` or
  keep the path with `cleaned: true` (choose one and test it),
- if cleanup fails, mark the run with a warning but do not apply anything.

### 3. Add a live-root unchanged assertion helper

Add a small helper in tests:

```ts
async function gitStatusPorcelain(root: string): Promise<string>
```

Use it around worker runs:

```text
before run: clean
after run: clean
```

The worker fake should write files in its `cwd`; the assertion proves those files
did not land in the real repo.

### 4. Harden `/delegate run`

In `slashCommands.ts`:

- refuse nested delegation as today,
- show isolation mode before spawning,
- show patch-only apply instructions after spawning,
- never offer "apply now" from `/delegate run`.

`/delegate run` produces artifacts only.

### 5. Harden `/delegate apply`

No architectural change: keep `applyWorker` as the only apply path. Add tests
that prove:

- a passed worker with a valid patch applies through `applyWorker`,
- the same patch is not applied by `runWorker`,
- non-TTY apply refuses,
- failed/empty/incomplete workers refuse.

### 6. Add `/delegate discard`

If not already complete, add the command now because it is the other half of
safe isolation UX.

Behavior:

- `discard <plan-id> <worker-id>` marks worker/run as discarded,
- removes kept isolated worktree if it still exists,
- keeps a small audit record under `.deepcoder/delegations/.../discard.json`,
- does not delete source files from the live repo.

If discard already exists, this phase only adds isolation-aware tests and output.

## Tests

Add or extend adversarial tests for delegation:

1. `runWorker` refuses `isolationConfig.mode = "off"`.
2. fake worker writes `src/generated.ts` in `cwd`; real root remains clean after
   `runWorker`.
3. fake worker exits 0 with patch; `runWorker` creates patch artifact but live
   repo remains unchanged.
4. fake worker exits nonzero after writing files; patch/log are captured, live
   repo remains unchanged.
5. fake worker times out after writing files; process is killed, live repo
   remains unchanged.
6. child env contains `DEEPCODER_WORKSPACE_ISOLATION=off` and cwd is the isolated
   root, not the real root.
7. run record includes isolation metadata.
8. cleanup failure is recorded as a warning and does not apply anything.
9. `/delegate review` includes patch path + changed files + isolation status.
10. `/delegate apply` is the only path that changes the live repo.
11. non-TTY `/delegate apply` refuses.
12. `/delegate discard` removes/marks artifacts and never touches live source.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

No live model is required. Use fake workers that edit their cwd and return fixed
exit codes.

Manual smoke, no model:

1. Create a test delegation plan with one worker.
2. Run `/delegate run` against a fake worker command or injected seam.
3. Confirm patch artifact exists.
4. Confirm `git status --porcelain` in the real repo is unchanged.
5. Run `/delegate review`.
6. Run `/delegate discard`.

Optional live smoke:

1. Run one small delegated worker with a real provider.
2. Confirm the live repo is unchanged after run.
3. Inspect patch.
4. Apply manually only after review.

## Risks

### Dirty tree false positives

Delegated isolation should keep refusing dirty trees by default. A future dirty
diff replay mode can be useful, but it must be explicit and heavily tested.

### Nested isolation confusion

The child must see `DEEPCODER_WORKSPACE_ISOLATION=off`. This is not unsafe: the
child's current working directory is already the isolated worktree. Tests should
assert both facts together so future readers do not "fix" it into nested
worktrees.

### Artifact path leaks

Patch/log paths are local metadata. They should not be injected into model
prompts except as bounded operational output if the user explicitly asks for
status/review.

### Copy backend

If copy backend support is incomplete, delegated workers should initially require
git-worktree isolation and clearly refuse non-git repos. Do not ship a fragile
custom patch applier for copy mode in this phase.

## Implementation Order

1. Add `WorkerIsolationRecord` to delegate types.
2. Harden `runWorker` to refuse `mode: "off"` and record isolation metadata.
3. Add live-root-clean tests around fake worker writes, failures, and timeouts.
4. Update `/delegate status` and `/delegate review` rendering.
5. Add or harden `/delegate discard`.
6. Add apply-path exclusivity tests.
7. Update Phase 9 docs to state delegated-worker isolation is mandatory.
8. Run full gate.

## Definition of Done

- Delegated workers cannot be configured to edit the live repo directly.
- Every worker run leaves an auditable isolation record.
- The live repo remains clean after worker success, failure, and timeout.
- Review/apply/discard UX clearly separates "worker produced a patch" from
  "patch was applied".
- Tests fail if a future change lets `/delegate run` mutate live files.
