# Full system audit plan

## Goal
Systematic review of every major subsystem in deepcoder, identifying security issues, correctness bugs, edge cases, and technical debt. Run incrementally — one subsystem at a time.

## Audit areas

### 1. Permission system (security-critical)
**Files:** `src/permissions/`, `src/workspace/sensitive.ts`, `src/workspace/paths.ts`
**Already planned:** `audit-permission-system.md`

### 2. Agent loop (orchestration)
**Files:** `src/agent/agentLoop.ts`, `src/agent/systemPrompt.ts`
**Already planned:** `audit-agent-loop.md`

### 3. Checkpoint/rollback (correctness)
**Files:** `src/session/checkpoints.ts`
**Already planned:** `audit-checkpoint-rollback.md`

### 4. Workspace isolation (dual-root)
**Files:** `src/workspaceIsolation/`
**Already planned:** `audit-workspace-isolation.md`

### 5. Delegation system (multi-worker)
**Files:** `src/delegate/`
**Already planned:** `audit-delegation-system.md`

### 6. Provider abstraction (DeepSeek-only)
**Files:** `src/providers/deepseek.ts`, `src/providers/openaiCompatible.ts`, `src/providers/factory.ts`
**Already planned:** `audit-provider-abstraction.md`

### 7. Compaction and context
**Files:** `src/context/compaction.ts`, `src/context/tokenBudget.ts`
**Already planned:** `audit-compaction.md`

### 8. File tools (not yet planned)
**Files:** `src/tools/readFile.ts`, `src/tools/editFile.ts`, `src/tools/writeFile.ts`, `src/tools/deleteFile.ts`, `src/tools/renameFile.ts`, `src/tools/applyPatch.ts`, `src/tools/runBash.ts`, `src/tools/grep.ts`, `src/tools/glob.ts`, `src/tools/listDir.ts`

**What to verify:**
- **Path resolution**: every file tool resolves paths through `resolveInWorkspace`/`resolveReadPathInWorkspace`. Are there any tools that use raw `path.join`?
- **Sensitive-path bypass**: can any tool read/write a sensitive path through a symlink?
- **Read-before-write**: `edit_file` and overwriting `write_file` require the file to have been read. Is this enforced in all code paths? Can `apply_patch` bypass it?
- **File size limits**: `read_file` caps at 1 MB. Do other tools have similar caps? (`grep` on a 100 MB file?)
- **Binary file handling**: what happens when `edit_file` is called on a binary file? Does it corrupt it or refuse?
- **Concurrent access**: two simultaneous tool calls to the same file — race conditions?
- **Temp file safety**: do any tools write temp files in predictable locations?

### 9. Session persistence (not yet planned)
**Files:** `src/session/sessionStore.ts`, `src/session/checkRuns.ts`, `src/session/goal.ts`

**What to verify:**
- **Atomic saves**: `SessionStore.save` uses `writeFile` + `rename`. Is this atomic on all platforms? (Windows: `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`)
- **Corruption recovery**: what happens if a session file is corrupted? `loadSession` just parses and throws. Should it recover or at least report a useful error?
- **Sensitive data in session files**: messages contain tool inputs/outputs. Could API keys or secrets appear in session messages? (yes — the user might paste a key in a prompt. Session files are under `.deepcoder/` which is gitignored, but the data persists on disk.)
- **Session enumeration**: `listSessions` reads all `.json` files in the sessions directory. Could a user craft a malicious `.json` file that causes a crash? (parse errors are caught — check the catch-all)
- **Storage leaks**: sessions are never cleaned up. Does a long-running deepcoder user accumulate GBs of session data? Should there be a retention policy?

### 10. Sandbox (not yet planned)
**Files:** `src/sandbox/`

**What to verify:**
- **Bubblewrap invocation**: is the bwrap command constructed safely? Can a malicious workspace path inject bwrap arguments? (bwrap uses `--bind` with paths — path injection into bwrap args could escape the sandbox)
- **Environment cleanup**: bwrap clears the environment. Are ALL secrets removed? (API keys are in env vars — verified, they're cleared. But what about `HOME`, `USER`, `SSH_AUTH_SOCK`?)
- **Network isolation**: when `network: off`, is the network actually blocked? (bwrap `--unshare-net` is used — confirm)
- **Fallback behavior**: when bwrap is unavailable, falls back to `local` with a warning. Is the warning prominent enough?
- **Timeout**: sandboxed commands have a timeout. Does SIGKILL actually kill the process tree? (bwrap creates intermediate processes)

### 11. TUI rendering (not yet planned)
**Files:** `src/ui/`

**What to verify:**
- **ANSI injection**: user-provided content (file contents, command output) is rendered in the TUI. Can a malicious file inject ANSI escape codes that confuse the terminal? (e.g., hide text, overwrite the prompt)
- **Frame builder**: `minimalRenderer.ts` builds frame lines. Are all inputs bounded? (viewport size, input length, line count)
- **Input handling**: `inputEditor.ts` — are there key combinations that could crash or escape? (Ctrl-C, Ctrl-Z, terminal resize during frame render)
- **Layout engine**: `layout.ts` — does it handle terminal resize correctly? (SIGWINCH during a frame render)

### 12. CLI entrypoint (not yet planned)
**Files:** `src/cli/main.ts`, `src/cli/repl.ts`

**What to verify:**
- **Argument parsing**: `commander` is used. Are there flags that consume subsequent arguments incorrectly? (e.g., `--check` without a value consuming the next positional arg)
- **Signal handling**: SIGINT during tool execution, during provider streaming, during checkpoint save. Are all cases covered?
- **Non-TTY mode**: when stdin is not a TTY, the TUI is disabled. Are there any code paths that assume a TTY?
- **Resume logic**: `--resume <id>` loads a session. If the session's provider doesn't match the current config, what happens? (should warn — verify)
- **Configuration precedence**: CLI flag > env var > config file > default. Are there any config values where precedence is wrong?

### 13. Dependencies and supply chain (not yet planned)
**Files:** `package.json`, `package-lock.json`

**What to verify:**
- **Outdated dependencies**: any packages with known vulnerabilities? (run `npm audit`)
- **Unnecessary dependencies**: any packages imported but never used? (`package.json` lists deps — verify each is actually imported in code)
- **Supply chain risk**: how many dependencies have lifecycle scripts? (check `trustedDependencies` — `esbuild`, `node-pty`, etc.)
- **Lockfile integrity**: `package-lock.json` — frozen install vs regular install. Are there any drift issues?

### 14. Test coverage (not yet planned)
**Files:** `test/`

**What to verify:**
- **Coverage gaps**: which subsystems have no unit tests? (run `npm test -- --coverage` or equivalent)
- **Adversarial coverage**: the adversarial suite covers permission bypasses. What about tool argument injection, path traversal in edge cases, concurrent access races?
- **Fixture hygiene**: test fixtures should never contain real secrets. Are there any test files with placeholder secrets? (check for `sk-` patterns in fixtures)
- **Integration tests**: are there tests that run against a real provider? (should not — the `test:live` script is separate)

## Execution order

| Priority | Area | Reason |
|---|---|---|
| 1 | Permission system | Security-critical, hardest to fix later |
| 2 | File tools | Most attacked surface (edit/read/write) |
| 3 | Sandbox | Security-critical, privilege escalation risk |
| 4 | Checkpoint/rollback | Data integrity |
| 5 | Workspace isolation | Dual-root correctness |
| 6 | Agent loop | Central orchestration |
| 7 | Session persistence | Data storage |
| 8 | Provider abstraction | Now DeepSeek-only, simpler |
| 9 | Delegation system | High complexity, lower risk |
| 10 | TUI rendering | Non-critical |
| 11 | CLI entrypoint | Error handling polish |
| 12 | Compaction | Correctness |
| 13 | Dependencies | Maintenance |
| 14 | Test coverage | Meta-audit |

## Deliverable format
For each subsystem, produce:
1. **Risk summary**: what could go wrong (1-3 sentences)
2. **Finding list**: specific issues found, with file:line references
3. **Severity**: security / correctness / performance / polish
4. **Fix recommendation**: what to change, with code sketch
5. **Test gap**: what test should exist but doesn't

## Timeline
Estimates assume focused work on one subsystem at a time.

| Area | Estimated effort |
|---|---|
| Permission system | 2 days |
| File tools | 1 day |
| Sandbox | 1 day |
| Checkpoint/rollback | 1 day |
| Workspace isolation | 1 day |
| Agent loop | 1 day |
| Session persistence | 0.5 day |
| Provider abstraction | 0.5 day |
| Delegation system | 1 day |
| TUI rendering | 0.5 day |
| CLI entrypoint | 0.5 day |
| Compaction | 0.5 day |
| Dependencies | 0.5 day |
| Test coverage | 0.5 day |
| **Total** | ~11 days |
