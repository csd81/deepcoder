# Phase 7E — Isolation dependency provisioning

## Context

Phase 7D runs agent edits in a detached `git worktree` of `HEAD` (`src/workspaceIsolation/`). But
`git worktree add` checks out **tracked files only** — so the worktree has **no `node_modules`, no
`dist/`, no `.deepcoder/`** (all gitignored). A JS test-check (`node --import tsx --test …`) or a
Python check needing installed deps therefore **can't run in the worktree**, which means
`--workspace-isolation patch --solve --check <js-test>` cannot verify.

This is a real, observed gap: every isolated self-fix run this session needed a manual workaround —
`ln -s <real>/node_modules <worktree>/node_modules` plus copying the check config. Worse, when the
7A sandbox is also on, a bare symlink to the real `node_modules` **dangles inside bwrap** (the target
isn't bound), so the two features don't compose. The 7D plan actually lists `node_modules` only to
*exclude* it from the (deferred) copy backend — it never provisions deps. Phase 7E fixes this so the
isolated-solve flow works without hand-patching.

## Decisions (locked)
- **Symlink, don't copy.** Provision dep dirs by symlinking the worktree entry to the real root's
  copy (fast, no duplication). Cleanup removes the worktree (and its symlinks); removing a symlink
  never touches the target.
- **Allowlist only.** Provision a small configurable allowlist (default `["node_modules"]`); never
  link secrets, `.env`, `.deepcoder/sessions`, or arbitrary paths.
- **Control-plane stays on the real root.** `runCheck` already gets the check *command* from
  real-root config and runs it with `cwd = executionRoot` (the worktree) — so `.deepcoder/config.json`
  does **not** need to be in the worktree. Don't copy `.deepcoder/`; document that check commands must
  not depend on `.deepcoder/` contents.
- **Compose with the sandbox (the key fix).** When `sandbox.mode !== "off"` and isolation is active,
  the provisioned symlink *targets* (e.g. the real `node_modules`) are auto-added to the sandbox as
  **read-only `extraMounts`** for the run, so the symlink resolves inside bwrap. This makes
  `--workspace-isolation patch --sandbox fast --solve --check <js>` actually work.
- **Provisioning failure is loud, not silent.** If provisioning fails and the check then can't run,
  report it clearly — never declare solved on an unverifiable check.

## Design
- **New** `src/workspaceIsolation/provision.ts`: `provisionWorktree(realRoot, isolatedRoot, config)` —
  for each allowlisted dir that exists in `realRoot` and is absent in the worktree, create a symlink
  `isolatedRoot/<dir> -> realRoot/<dir>`. Returns the list of `{ link, target }` for sandbox-mount
  composition. Idempotent; skips dirs already present (e.g. tracked).
- **Edit** `src/workspaceIsolation/gitWorktree.ts`: after `git worktree add`, call `provisionWorktree`
  and stash the provisioned targets on the `IsolatedWorkspace` (e.g. `sandboxMounts: SandboxMount[]`).
  Cleanup is unchanged (the temp base removal takes the symlinks with it; targets untouched).
- **Edit** `src/workspaceIsolation/types.ts` + config (`fileConfig.ts`/`config.ts`):
  `WorkspaceIsolationConfig` gains `provision: string[]` (default `["node_modules"]`) and optional
  `setupCommands: string[]` (e.g. `["npm ci --offline"]`) for repos that prefer a real install over a
  symlink — run via `runCheck` (gated/sandboxed/bounded), opt-in.
- **Edit** `src/cli/main.ts` `setupIsolation`: when isolation is active, merge the worktree's
  `sandboxMounts` (ro) into the sandbox config used for that run's checks/`run_bash` (a per-run
  sandbox override threaded to `runCheck`/`ToolContext.sandbox`), so bwrap binds the dep targets.

## Reuse
- `src/workspaceIsolation/gitWorktree.ts` (`createGitWorktree`, cleanup) — provisioning hooks in after
  `worktree add`.
- 7A `SandboxConfig.extraMounts` (already read-only by default) + `wrapCommand` — the composition point.
- `runCheck` for optional `setupCommands` (no new execution surface).

## Acceptance
**No-model:**
- Unit/integration: temp git repo with a fake `node_modules/marker.js`; `provisionWorktree` →
  the worktree's `node_modules` symlink resolves to the real one; `cleanup` removes the worktree
  **without** deleting the real `node_modules`.
- Integration: a JS check (`node --import tsx --test <file>`) runs green in a *provisioned* worktree
  with **no manual symlink** — sandbox off, and (if `bwrap` present) sandbox `fast` with the dep
  target auto-mounted ro.
- Regression: non-isolated runs unchanged; provisioning happens only when isolation is on.
- **End-to-end**: the exact self-fix flow run by hand this session
  (`--workspace-isolation patch --solve --check <test>`) works **without** `ln -s node_modules` or a
  config copy.

## Safety invariants
- Only allowlisted dep dirs are linked; never secrets/`.env`/`.deepcoder/sessions`.
- Sandbox `extraMounts` for deps are **read-only**.
- Cleanup removes worktree-local symlinks only; link targets (the real deps) are never deleted.
- A check that can't run after provisioning reports clearly; never a silent "solved".

## Out of scope
Default `npm ci` per run (opt-in via `setupCommands` only); language-specific package managers beyond
the allowlist + `setupCommands` escape hatch; remote/container provisioning; the copy backend
(still deferred from 7D).

## Implementation order
1. `types.ts` + config fields (`provision`, `setupCommands`).
2. `provision.ts` (symlink) + unit test (resolve + cleanup-safety).
3. `gitWorktree.ts` integration (provision after add; expose `sandboxMounts`).
4. Sandbox composition in `setupIsolation` + integration test (bwrap dep-mount).
5. End-to-end isolated `--solve --check <js>` with no manual setup.
6. Docs + ROADMAP (7E entry; note it unblocks the isolated-solve loop).
