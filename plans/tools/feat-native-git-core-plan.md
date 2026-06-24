# Feature — Native git in core (deepcoder owns git, deterministically)

## Context

git is the **guardrail + audit trail** for all AI automation — every change tracked,
diffable, reversible. Today deepcoder relies on the AI emitting `git` shell commands, which
(a) the command classifier **blocks** for headless workers (proven: `delegate merge`/the
merge-runner were denied `git merge`/`gh`), and (b) can't be reliably tracked. So git must be
a **first-class, deterministic, permission-gated CORE capability** — like `delegate merge`
already owns merge — not an ad-hoc agent shell call.

`src/workspace/git.ts` already wraps *some* ops (status/diff/branch helpers). This builds out
the full surface, **one command at a time**, with read-only ops free and state-changing ops
gated.

## Foundation FIRST (Phase 0 — in-house, blocks everything else)

`src/git/core.ts` — the single primitive every phase builds on:
```ts
export type GitArgs = string[];
export interface GitExecResult { code: number; stdout: string; stderr: string; }
// Deterministic git runner. `mutating: true` ops route through the permission policy
// (never an agent shell call); read-only ops run freely. Never `--force` unless explicit.
export async function gitExec(root: string, args: GitArgs, opts?: { mutating?: boolean }): Promise<GitExecResult>;
export function isMutatingGit(args: GitArgs): boolean;   // pure classifier: read-only vs state-changing
```
Plus a per-command **flag allowlist** so only vetted flags reach git (defense in depth).
**Build Phase 0 in-house** — the other phases each import it, so it can't be parallelized.

## Phases 1–5 (PARALLELIZABLE — one disjoint module each, all built on `gitExec`)

Each phase = its own file → workers don't collide. Each command: a typed wrapper +
the key flags, read-only or gated.

| Phase | Module | Commands (+ key flags) | R/O or gated |
|---|---|---|---|
| **1 Read** | `src/git/read.ts` | `status --porcelain`, `diff [--cached/--stat/--name-only]`, `log [--oneline/-n/--format]`, `show`, `branch --list`, `ls-files`, `rev-parse`, `rev-list --count`, `blame` | **read-only (free)** |
| **2 Commit** | `src/git/commit.ts` | `add [-A/-p paths]`, `restore [--staged]`, `commit [-m/--amend/--no-edit]`, `reset [--soft/--mixed paths]` | gated |
| **3 Branch** | `src/git/branch.ts` | `branch [-d/-D/-m]`, `checkout`/`switch [-b/-c]`, `worktree [add -b/remove/prune/list]`, `tag [-a/-d]` | gated (list free) |
| **4 Integrate** | `src/git/integrate.ts` | `merge [--no-ff/--squash/--abort]`, `rebase [--onto/--continue/--abort]`, `stash [push -u/pop/list]`, `cherry-pick [--abort]`, `revert [--no-edit]`, `apply [--check/--3way]` | gated |
| **5 Remote** | `src/git/remote.ts` | `fetch`, `pull [--ff-only/--rebase]`, `push [-u/--delete] (never --force unless explicit)`, `remote [-v/get-url]`, `clean [-n]` | gated (read-only ones free) |

Existing `src/workspace/git.ts` helpers are migrated/re-exported through these so there's one
git surface, not two.

## Files to change
- **New:** `src/git/core.ts` (Phase 0), then `src/git/{read,commit,branch,integrate,remote}.ts`.
- **New tests:** one per module, against **temp git repos** (`mkdtemp` + `git init`).
- **Edit (later, in-house):** point `src/workspace/git.ts`, `openPr.ts`, `prMergeSeams.ts`,
  `mergeConflict.ts` at the new core so all git goes through it.

## Tests (RED first — git ops are deterministic against a temp repo)
- Phase 0: `gitExec` runs a read-only command; `isMutatingGit` classifies `commit`/`push` as
  mutating and `status`/`log` as read-only; a non-allowlisted flag is rejected.
- Per phase: each wrapper produces the right effect in a temp repo (e.g. `commit` creates a
  commit; `branch -b` makes a branch; `merge --abort` cleans state); `--force` requires an
  explicit opt-in.

## Safety / invariants
- **State-changing git is permission-GATED**, run as deterministic core code — NEVER an agent
  `run_bash`. Read-only git (`status`/`diff`/`log`) is free.
- **Never `--force`** (push/checkout/clean) unless an explicit caller flag is set.
- Flag allowlist per command — unknown flags are refused.
- All paths confined via the existing `resolveInWorkspace`.

## Sequencing
Phase 0 in-house → **then fan out Phases 1–5 as parallel workers** (disjoint modules) →
verify + `delegate merge` → finally migrate existing callers onto the core in-house.
