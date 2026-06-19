# Deepcoder Phase 7D — Workspace Isolation

## Context

Phase 7A added fast tool-level sandboxing: `run_bash`, configured checks, solve checks, and future hooks can run through a sandbox backend such as bubblewrap. That protects command execution, but it does **not** isolate Deepcoder's own file-editing tools. Today `edit_file` and `write_file` mutate the user's live working tree directly, even if shell commands are sandboxed.

Workspace isolation closes that gap. A Deepcoder run can happen in a temporary isolated workspace, then present a patch for explicit apply back to the real repo. This gives the user a cheap "try the agent safely" mode without paying the Docker cost for every iteration.

## Goal

Add an opt-in workspace isolation mode where agent file edits happen outside the live checkout by default, and the real repo is changed only when the user accepts the resulting patch.

```text
real repo -> isolated workspace -> agent edits/checks -> patch preview -> apply or discard
```

This is different from sandboxing:

- sandboxing isolates **commands**,
- workspace isolation isolates **file mutations**,
- both can be used together.

## Default

Initial default:

```text
workspaceIsolation.mode = "off"
```

Rationale: changing where edits land is a large UX shift. Ship it opt-in first, prove it with local-bench and self-fix flows, then consider making it default for `--solve` or dangerous modes later.

Recommended first opt-in:

```bash
deepcoder --workspace-isolation patch --solve --check unit "fix the bug"
```

## Modes

```text
off      current behavior; tools edit the live workspace
patch    run in an isolated workspace, then offer a patch to apply
keep     same as patch, but keep the isolated workspace for inspection
```

Deferred:

```text
branch   create a git branch and apply there
worktree persistent named git worktree
container workspace mounted into Docker/podman
```

## Isolation Backend

Use a temporary git worktree when possible:

```text
git worktree add --detach <tmp-workspace> HEAD
```

Fallback for non-git workspaces:

```text
copy current workspace to temp dir, excluding .git, .deepcoder/sessions, node_modules, dist, runs, caches
```

Why worktree first:

- fast,
- preserves ignored-file behavior,
- produces clean diffs,
- avoids copying large repos,
- keeps the user's current dirty tree untouched.

Important dirty-tree rule:

- If the live repo has uncommitted changes, default to refusing `patch` mode unless `--workspace-isolation-include-dirty` is set.
- Reason: a detached worktree from `HEAD` will not include unsaved user edits, so the agent may solve against stale code.
- Later improvement: copy the live dirty diff into the isolated workspace before the run.

## Config

Add to `.deepcoder/config.json`:

```json
{
  "workspaceIsolation": {
    "mode": "off",
    "backend": "auto",
    "keepOnSuccess": false,
    "keepOnFailure": true,
    "includeDirty": false,
    "exclude": ["node_modules", "dist", ".deepcoder/sessions", "evals/local-bench/runs"]
  }
}
```

Environment:

```bash
DEEPCODER_WORKSPACE_ISOLATION=off
DEEPCODER_WORKSPACE_ISOLATION=patch
DEEPCODER_WORKSPACE_ISOLATION=keep
```

CLI:

```bash
deepcoder --workspace-isolation patch ...
deepcoder --workspace-isolation keep ...
deepcoder --workspace-isolation off ...
deepcoder --workspace-isolation-include-dirty ...
```

Precedence:

```text
CLI > env > config file > default off
```

## Architecture

New module:

```text
src/workspaceIsolation/types.ts
src/workspaceIsolation/session.ts
src/workspaceIsolation/gitWorktree.ts
src/workspaceIsolation/copyWorkspace.ts
src/workspaceIsolation/patch.ts
```

Core shape:

```ts
interface WorkspaceIsolationConfig {
  mode: "off" | "patch" | "keep";
  backend: "auto" | "git-worktree" | "copy";
  keepOnSuccess: boolean;
  keepOnFailure: boolean;
  includeDirty: boolean;
  exclude: string[];
}

interface IsolatedWorkspace {
  realRoot: string;
  isolatedRoot: string;
  backend: "git-worktree" | "copy";
  cleanup(): Promise<void>;
  diff(): Promise<string>;
  changedFiles(): Promise<string[]>;
  applyPatchToRealRoot(opts: { force: boolean }): Promise<void>;
}
```

Main execution change:

```text
CLI receives task
  -> maybe create isolated workspace
  -> run agent with workspaceRoot = isolatedRoot
  -> checks also run in isolatedRoot
  -> collect patch
  -> show summary/diff
  -> user accepts or rejects
  -> apply patch to realRoot or discard
```

No provider, tool, or permission code should need to know whether the workspace is isolated. They only receive `workspaceRoot`.

## Patch Application

Preferred apply path:

```bash
git -C <realRoot> apply --index? --whitespace=nowarn <patch>
```

Initial implementation should **not** stage changes:

```bash
git -C <realRoot> apply --whitespace=nowarn <patch>
```

Conflict behavior:

- If the live tree changed while the isolated run was executing, `git apply --check` may fail.
- Report the failure and keep the isolated workspace if configured.
- Do not force apply by default.

For non-git copy backend:

- Generate a file-by-file patch from the copied workspace.
- Apply with a small internal patch applier only if safe.
- If that is too much for 7D, support `patch` mode for git repos only and clearly refuse non-git workspaces.

## UX

CLI output after an isolated run:

```text
workspace isolation: patch
isolated workspace: /tmp/deepcoder-ws-abc123
changed files:
  src/foo.ts
  test/foo.test.ts

Apply this patch to the real workspace? [y/N]
```

Slash commands:

```text
/isolation status
/isolation diff
/isolation apply
/isolation discard
/isolation path
```

For one-shot `--solve`, default behavior in `patch` mode:

- non-TTY: do **not** auto-apply,
- write patch artifact path,
- exit with a message telling the user how to apply it.

This avoids CI/headless runs silently mutating the live tree.

## Interaction With Checkpoints

If workspace isolation is active:

- checkpointing in the isolated workspace is optional and usually unnecessary,
- do not create checkpoints in the real workspace before apply,
- after apply, the existing checkpoint system may capture a real-root checkpoint if enabled.

Initial rule:

```text
workspace isolation patch mode disables auto-checkpoint during the isolated run
```

Reason: the isolated workspace itself is disposable and already acts as the undo boundary.

## Interaction With Sandbox

Both layers should compose:

```text
workspaceRoot = isolatedRoot
run_bash/check command = sandboxed inside isolatedRoot
file tools = confined to isolatedRoot
```

This is the safest common path:

```bash
deepcoder --workspace-isolation patch --sandbox fast --solve --check unit "fix bug"
```

## Safety Invariants

- Agent file tools never receive the real root when isolation is active.
- Generated patch must never include `.env`, `.deepcoder/sessions`, checkpoint blobs, or other sensitive paths.
- Applying patch must use `git apply --check` first.
- Non-TTY isolated runs must not auto-apply.
- Isolated workspace paths must not be persisted into long-term project memory.
- Cleanup must not delete anything outside the temp isolation root.

## Adversarial Tests

New test file:

```text
test/adversarial/workspace-isolation.test.ts
```

Required cases:

1. `edit_file` in isolated mode changes only the isolated workspace, not the real root.
2. `write_file` in isolated mode creates files only in the isolated workspace.
3. Generated patch applies cleanly to the real root after approval.
4. Non-TTY `--solve --workspace-isolation patch` does not auto-apply.
5. Dirty real repo refuses isolation unless `includeDirty` is true.
6. Sensitive files are excluded from generated patch artifacts.
7. Cleanup removes the temp workspace and cannot follow symlinks outside it.
8. Sandbox command execution uses the isolated root as cwd/workspace.
9. Apply conflict leaves the real tree unchanged and keeps the isolated workspace for inspection.
10. Copy fallback excludes `node_modules`, `.deepcoder/sessions`, benchmark runs, and caches.

## Verification

No-model gates:

```bash
npm run typecheck
npm run test:phase
npm run sandbox:smoke
```

Manual smoke:

```bash
npm run dev -- --workspace-isolation patch --mode auto \
  "create a small file named tmp-ws-isolation-smoke.txt"
```

Expected:

- file appears in isolated workspace first,
- real repo stays unchanged until apply,
- rejecting apply discards the file,
- accepting apply creates the file in the real repo.

Self-fix smoke:

```bash
npm run dev -- --workspace-isolation patch --sandbox fast \
  --solve --check sandbox-repro \
  "fix the sandbox fallback bug"
```

Expected:

- solve loop edits isolated workspace,
- check runs against isolated workspace,
- patch is previewed,
- real files change only after apply.

## Implementation Order

1. Config parsing and CLI flags for `workspaceIsolation`.
2. `gitWorktree` backend with dirty-tree refusal.
3. Isolated run wrapper in CLI/solve runner: swap `workspaceRoot` before building `ToolContext`.
4. Patch generation and apply flow for git repos.
5. Non-TTY behavior: never auto-apply; emit patch path.
6. Slash commands for status/diff/apply/discard.
7. Adversarial tests.
8. Docs and roadmap update.

## Acceptance

- `npm run test:phase` green.
- Existing non-isolated behavior unchanged.
- Isolated file edits do not touch the live repo before apply.
- `run_bash` and checks still route through the sandbox runner when configured.
- A failed or aborted isolated run leaves the live repo unchanged.
- A rejected patch leaves the live repo unchanged.

## Out Of Scope

- Full Docker-per-session isolation.
- Persistent branch/worktree management UI.
- Auto-merge of conflicting patches.
- Remote execution.
- Making workspace isolation the default.
- Applying isolated changes as git commits.
