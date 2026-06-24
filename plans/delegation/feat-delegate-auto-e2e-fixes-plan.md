# Slice 3.5 — make `delegate auto` actually work end-to-end

## Context

A live acceptance run (`deepcoder delegate auto "<task>" --no-pr`) proved that
`delegate auto` is **unit-green but not end-to-end functional** — the Slice-1/2/3
tests all injected seams for plan/run/validate/pr, so they never exercised the real
planner, worker-worktree, or `openPr`. The live run exposed three integration gaps:

1. **`Unknown check "phase"`** — `runWorker` creates an isolated worktree but never
   provisions `.deepcoder/config.json` (gitignored; defines the `phase` check) or
   `node_modules` into it, so every worker fails its `--check phase`.
2. **The heuristic planner over-splits** — *"add an `isBlank` helper"* produced **5**
   workers with junk `allowedPaths` (`pure`, `helper`, `isblank`, `value`, `string`)
   extracted as task words.
3. **`openPr` never applies the worker's patch** — workers produce
   `.deepcoder/delegations/<plan>/runs/<worker>/patch.diff`, but `openPr` operates on
   the **current branch** (`git add -A`, `git push origin <current>`), so it would push
   master with the work never applied.

**`scripts/delegate.sh` stays until this lands** — it is currently the only path that
works e2e, precisely because it hand-handles (1) and (3). This slice closes the gaps so
a live `delegate auto "<task>"` yields a real, reviewable PR; then Slice 4 can retire
the script.

## Fix A — Provision the worker worktree (`src/delegate/workerRunner.ts`)
After `createIsolatedWorkspace` (`runWorker`, ~:264), before `spawnWorker`, into
`iso.isolatedRoot`:
- copy `realRoot/.deepcoder/config.json` → `isolatedRoot/.deepcoder/config.json`
- symlink `realRoot/node_modules` → `isolatedRoot/node_modules` (if absent)

Mirror what `scripts/delegate.sh` does (`cp -r .deepcoder`, `ln -s node_modules`).
**Test:** `runWorker` with a fake `spawnWorker` → assert `.deepcoder/config.json` and
`node_modules` exist in the worktree at spawn time.

## Fix B — Apply the worker's patch to a fresh branch before the PR
Add `prepareWorkerBranch(root, planId, workerId, { branch, base })` (new, e.g. in
`src/delegate/openPr.ts` or a sibling):
- create branch `<branch>` off `base` (worktree or `git checkout -b` in a temp clone),
- `git apply --check` then `git apply --whitespace=nowarn` the worker's `patch.diff`
  (reuse the mechanism in `src/delegate/apply.ts`),
- `git add -A` + commit, return the branch name.

Then wire `runDelegatePr` (`src/cli/delegateCli.ts`) to call `prepareWorkerBranch`
**before** `openPr` (only when `applyable`), and have `openPr` push **that** branch
(pass `opts.branch`) — never the current one.
**Test:** temp git repo + a `patch.diff` → `prepareWorkerBranch` yields a branch whose
tree contains the patched change, and master/base is untouched.

## Fix C — Stop the planner over-splitting (`src/delegate/planner.ts`)
`inferAreas` treats task words as file areas even when they are not real paths. Make it
conservative: an inferred area counts **only if it maps to an existing path** under the
repo (an `src/<area>` dir, or a file the task names). If fewer than 2 real areas →
**one** worker. Small/simple tasks must produce a single worker.
**Test:** `buildPlan("add an isBlank helper to src/util/strings.ts")` → **1** worker
with a sane `allowedPaths`; a task naming two existing dirs → 2 workers.

## Acceptance (the real test is LIVE, not unit)
Re-run `deepcoder delegate auto "Add a pure isBlank(value) helper to src/util/strings.ts
with a test"` → **one** sane worker → green `--check phase` → `applyable` → a branch
containing the patch → **a real PR against master**. Unit tests gate the parts; the live
e2e is acceptance.

## Files to change
- `src/delegate/workerRunner.ts` (Fix A)
- `src/delegate/openPr.ts` + `src/cli/delegateCli.ts` (Fix B)
- `src/delegate/planner.ts` (Fix C)
- `test/delegate-auto-e2e-fixes.test.ts` (+ temp-git integration cases)

## Safety / invariants (do not weaken)
- **Never push or PR `master`.** `prepareWorkerBranch` always creates a NEW branch off
  `base`; `openPr` pushes that branch, never the current one.
- Branch-first preserved; the PR is the review gate; never auto-merge.
- Provisioned `node_modules` is a gitignored symlink; the patch already excludes
  `.deepcoder/`.
- The 9 gates still run before any PR — a non-applyable worker never reaches `openPr`.
