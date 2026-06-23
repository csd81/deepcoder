# Audit: Workspace isolation

## Scope
`src/workspaceIsolation/` — disposable git worktrees, dual-root architecture, dependency provisioning, patch apply.

## What to verify

### Dual-root correctness
- Control plane (config, sessions, MCP, instructions) runs on the REAL root. Execution plane (file tools, run_bash, checks) runs in the WORKTREE.
- Are there any code paths that use the wrong root? (e.g., reading config from the worktree, or writing files to the real root)
- The isolation module sets `session.executionRoot` to the worktree path. Are all file tool paths resolved against this?
- `resolveInWorkspace` and `resolveReadPathInWorkspace` — do they use the correct root? Trace each call site.

### Git worktree safety
- Worktree is created from `HEAD`. Uncommitted changes in the real repo are NOT in the worktree — the agent edits stale code.
- `--workspace-isolation-include-dirty` forces inclusion of dirty files. How? (copies files or uses `git stash`?)
- Cleanup: are worktrees always removed? What if the process crashes before cleanup?
- Concurrent worktrees: multiple agents or multiple isolation sessions could create overlapping worktrees. Does the naming scheme prevent collisions?

### Patch application
- `git apply --check` runs before actual apply — but what if the real repo changed between generate and apply?
- The patch is generated from `git diff` against the worktree. Does it include binary files? Permissions? Symlinks?
- After apply, the user is prompted. What happens in non-TTY mode? (writes `.deepcoder/isolation-*.patch` — correct, safe)

### Dependency provisioning
- `node_modules` is symlinked into the worktree. What if the real repo's `node_modules` is a symlink itself? (double symlink — does it resolve?)
- What about non-JS dependencies? (Python virtualenv, Go modules, Rust target dir)
- The provision list is configurable. Are there security implications? (provisioning a `.env` file into the worktree would leak secrets)

### Sandbox composition
- Workspace isolation + sandbox (Phase 7A + 7D) compose: the worktree is the execution root, and risky commands run inside bubblewrap within the worktree.
- Does the sandbox configuration respect the execution root? (bubblewrap binds the worktree as writable, not the real root)
- Does `--sandbox off` correctly disable sandboxing for isolation runs?

## Deliverables
- Root-resolution flow diagram (which code paths use which root)
- Isolation+containment+workspace isolation interaction matrix
- Worktree cleanup reliability test (SIGKILL during isolation → worktree cleaned up?)
- Non-TTY patch application test
