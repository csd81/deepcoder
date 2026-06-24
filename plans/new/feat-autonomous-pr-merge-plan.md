# Feature — Autonomous PR check → resolve → merge (`delegate merge`)

## Context

The delegation loop now produces PRs autonomously (`delegate auto`), but a human
still does the **last mile by hand** on every PR: run verify-then-force (scope,
non-vacuous, gates), `git merge-tree` to detect conflicts, resolve any conflicts,
then `gh pr merge`. This session alone that ritual ran ~8 times. This feature
automates it — closing the loop so a delegation goes **task → PR → checked →
conflicts-resolved → merged**, all gated, all hands-off.

It is **additive — compose existing infra, don't rebuild it:**

| Step | Reuse |
|---|---|
| Is the PR safe to merge? | the 9 gates — `loadAndValidateWorker` (`validation.ts`) → `applyable`; surfaced by `delegate validate` (`delegateCli.ts`) |
| Are there conflicts vs base? | `git merge-tree` (what verify-then-force does by hand today) |
| Resolve conflicts | `src/cli/mergeConflict.ts`: `detectConflicts`, `readConflict` (builds base/ours/theirs context for the agent), `hasConflictMarkers`, `filesStillConflicted` — the `/resolve` machinery |
| Fetch a PR's diff | `src/cli/prFetch.ts`: `fetchPr`, `getPrDiff` |
| Merge | `gh pr merge` (never force, never auto-merge a failing gate) |

## Model

`deepcoder delegate merge [<pr-number>…] [--all-delegated] [--dry-run] [--json]`
— for each target PR:

1. **Check (the gate).** Validate the PR's worker (or, for a non-delegated PR, run
   the verify-then-force checks: scope, non-vacuous, `test:phase` green). If not
   `applyable` → **skip, report why**, never merge.
2. **Detect conflicts.** `git merge-tree $(merge-base base head) base head`; count
   conflict hunks.
3. **Resolve (only if conflicts).** Check out the branch, attempt `git merge base`;
   for each conflicted file (`detectConflicts`), build context with `readConflict`
   and have the agent produce a resolved file; verify with `filesStillConflicted` /
   `hasConflictMarkers`. Commit the resolution, push, then **re-run the gate** on the
   merged result (a resolution can't smuggle in a regression).
4. **Merge.** `gh pr merge <n> --merge` only when gate-green AND conflict-free.
   Otherwise leave the PR open with a comment listing the failing gate / unresolved
   files. **Never** `--force`, **never** merge a red gate.
5. **Cleanup (only after a successful merge).** Tear down everything that merge
   created, idempotently and scoped to **this PR's own** artifacts:
   - remote branch: `gh pr merge --delete-branch` (or `git push origin --delete <branch>`);
   - local worktree + branch: `git worktree remove --force ../deleg-<branch>`,
     `git branch -D <branch>`, `git worktree prune`;
   - sync local master: `git fetch origin` + fast-forward/rebase;
   - drop this run's temp files: `/tmp/deleg-<branch>.log{,.exit,.pr,.prbody}`, task file.
   **Never blanket-`rm`** `/tmp/deleg-*` or `../deleg-*` (that kills other agents'
   in-flight runs — parse the exact paths for THIS run only). A failed/skipped merge
   cleans up nothing (the branch must survive for re-work).

## Design

### New: `src/delegate/prMerge.ts` (pure-ish orchestration, seam-injected)
```ts
export interface PrMergeResult {
  pr: number;
  outcome: "merged" | "skipped-not-applyable" | "resolved-and-merged" | "conflicts-unresolved" | "error";
  failingGates?: string[];
  unresolvedFiles?: string[];
}
export async function mergePr(
  pr: number,
  deps: {
    validate: (pr: number) => Promise<{ applyable: boolean; failures: { code: string }[] }>;
    conflicts: (branch: string, base: string) => Promise<string[]>;   // git merge-tree → conflicted files
    resolve?: (files: string[]) => Promise<string[]>;                 // agent resolve → still-conflicted (mergeConflict.ts)
    merge: (pr: number) => Promise<void>;                             // gh pr merge
  },
  opts?: { dryRun?: boolean },
): Promise<PrMergeResult>;
```
All side-effecting steps are injected seams → unit-testable with no live model, no
`gh`, no real git. The CLI wires the real `delegate validate`, `git merge-tree`,
`mergeConflict.ts` + agent, and `gh pr merge`.

### Wire `delegate merge` into `registerDelegateCommand` (`delegateCli.ts`)
Next to `auto`/`pr`/`validate`. `--all-delegated` enumerates open PRs whose head
branch is a delegation branch (or titled `[delegated]`).

### Conflict-resolution path (reuse `/resolve`)
Do **not** reinvent merge-conflict handling: `mergeConflict.detectConflicts` lists
conflicted files; `readConflict` produces the `{ base, ours, theirs }` blob the agent
resolves; `filesStillConflicted` is the resolved-signal. The agent step is the same
read-only-context → produce-resolved-file flow `/resolve` already uses.

## Load-bearing constraint — the MERGE is deterministic CLI, NOT a delegated agent

Dogfood finding: a headless delegated worker **cannot** run the merge. deepcoder's
command classifier **auto-denies** `gh pr merge`, `git merge`, `git push` (and even
`gh pr view`) for a non-interactive worker — only read-only `git status/diff/log/show`
are auto-allowed. **This is the safety model working as designed.** So:

- The **agent decides whether to merge** (the gates) and **resolves conflicts** (the
  agentic `/resolve` flow) — those are legitimate agent work.
- The **merge itself runs in deterministic CLI code** (`runDelegateMerge` calling `gh`
  directly, *outside* the agent loop's permission gate), gated on the validation result.
  That is exactly why `prMerge.ts`'s `merge` is an **injected seam** — never an agent
  `run_bash`. `delegate merge` is a CLI command, not a `delegate auto` worker task.

## Files to change
- **New:** `src/delegate/prMerge.ts`, `test/adversarial/delegate-merge.test.ts`.
- **Edit:** `src/cli/delegateCli.ts` — add `runDelegateMerge` + register `delegate merge`.
- (Resolution reuses `src/cli/mergeConflict.ts` unchanged; merge reuses `gh` from CLI.)

## Tests (RED first, all seam-injected — no live model / gh / git)
- **gate blocks merge:** a non-applyable PR → `skipped-not-applyable`, `merge` NOT called.
- **clean + applyable → merged:** `merge` called exactly once.
- **conflicts → resolve → re-gate → merge:** `conflicts` returns files, `resolve`
  clears them, gate passes again, `merge` called. (`resolved-and-merged`.)
- **unresolved conflicts → no merge:** `resolve` leaves files conflicted →
  `conflicts-unresolved`, `merge` NOT called.
- **resolution that regresses the gate → no merge:** after resolve, re-validate fails
  → not merged (proves the post-resolution re-gate).
- **--dry-run:** reports outcomes, calls neither `resolve` nor `merge`.
- **adversarial:** a PR that becomes non-applyable between check and merge is not merged
  (re-check immediately before `gh pr merge`).

## Verification
- `npm run typecheck` clean; `npm run test:phase` green with the new tests.
- **Live acceptance:** open a trivial delegated PR, `deepcoder delegate merge <n>` →
  it validates, finds no conflicts, merges; then a PR engineered to conflict with master
  → it resolves via `/resolve`, re-gates, and merges, leaving an audit comment.

## Safety / invariants (do not weaken)
- **The gate is the merge condition** — `applyable` (9 gates) green is necessary; a red
  gate is NEVER merged, even with `--force` absent by design.
- **Re-gate after conflict resolution** — a resolution is untrusted until the gates pass
  on the merged tree.
- **Re-check immediately before merge** — guards the check→merge race.
- **Never force-merge, never delete a branch with unmerged work.** Leave failing PRs
  open with a diagnostic comment.
- Conflict resolution is the existing `/resolve` flow — bounded, agent-assisted, the
  resolved tree losing its markers is the only "resolved" signal (`hasConflictMarkers`).
