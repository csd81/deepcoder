# Deepcoder Phase 7H - Persistent Stateful Shell Sessions

## Context

Today `run_bash` and configured checks execute as individual bounded processes:

- each command starts from `ctx.workspaceRoot`,
- `cd`, exported variables, aliases, shell functions, and background jobs do not
  persist,
- every command is wrapped/sandboxed independently,
- process lifetime is simple and safe.

This is robust, but inefficient for iterative development. The model repeatedly
has to re-enter directories, re-export environment variables, restart watchers,
and re-discover the same shell state.

Phase 7H adds optional stateful PTY sessions: a managed background shell that
persists across consecutive agent turns while keeping the existing one-shot
bounded process runner as the default and fallback.

## Goal

Provide a safe, opt-in persistent shell session backend for interactive
development workflows.

```text
/shell start
  -> persistent PTY shell
  -> run commands in same shell state
  -> cd/env/watchers persist
  -> /shell stop cleans up
```

## ROI

High for developer ergonomics and long-running workflows:

- `cd packages/api` persists,
- `export FOO=bar` persists,
- `npm run dev` / watchers can keep running,
- less repeated navigation and setup,
- faster interactive debugging.

## Non-Goals

- Do not make PTY sessions the default for all commands in v1.
- Do not bypass permission policy.
- Do not bypass sandbox policy.
- Do not persist shell sessions across CLI restarts in v1.
- Do not expose arbitrary local terminal state to the model.
- Do not run delegated workers through the parent PTY.

## Design Decision

Use explicit session commands first:

```text
/shell start [name]
/shell run <command>
/shell status
/shell stop [name]
```

Then add an optional `run_bash` argument:

```json
{ "command": "pwd", "session": "default" }
```

Default remains one-shot `run_bash`.

Reason: persistent shell state changes the safety and reproducibility model.
Opt-in slash commands make the UX clear and testable before model-autonomous use.

## Architecture

New module:

```text
src/pty/sessionManager.ts
src/pty/types.ts
src/pty/transcript.ts
```

Potential dependency:

```text
node-pty
```

If `node-pty` install/build friction is too high, start with a pseudo-session
adapter around a long-lived `/bin/sh` child using pipes, then upgrade to true PTY.
The interface should not expose the implementation detail.

## Core Types

```ts
export interface PtySessionConfig {
  enabled: boolean;
  defaultShell: string;
  maxSessions: number;
  idleTimeoutMs: number;
  maxTranscriptBytes: number;
  commandTimeoutMs: number;
  allowRunBashSessionArg: boolean;
}

export interface PtySession {
  id: string;
  cwd: string;
  shell: string;
  startedAt: string;
  lastUsedAt: string;
  status: "running" | "exited";
}

export interface PtyRunResult {
  sessionId: string;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  exitMarkerSeen: boolean;
}
```

## Command Execution Protocol

Running a command in a persistent shell needs a reliable completion marker:

```sh
<command>
printf '\n__DEEPCODER_EXIT_%s:%s__\n' "$nonce" "$?"
```

The PTY manager:

1. writes command plus marker to the PTY,
2. streams output until marker appears or timeout,
3. strips marker from returned output,
4. records exit code,
5. redacts and caps output.

If marker is not seen before timeout:

- return `timedOut: true`,
- keep session running if possible,
- warn that command may still be active,
- user can `/shell interrupt` or `/shell stop`.

## Permissions

Every command sent to a PTY must still pass the existing permission flow:

```text
tool invocation -> classifyCommand/checkPermission -> approval/hook -> pty run
```

Persistent state must not create a privileged path around:

- `classifyCommand`,
- PreToolUse hooks,
- approval mode,
- readonly mode,
- sandbox selection.

Readonly mode:

- `/shell run` and session-backed `run_bash` are denied.

Auto mode:

- allowed commands run,
- ask commands still require approval or headless denial,
- denied commands never reach the PTY.

## Sandbox Interaction

This is the hard part.

One-shot bubblewrap wraps a process and exits. A persistent shell under bubblewrap
must be created inside one long-lived sandbox. That is feasible, but it changes
the sandbox lifetime.

V1 modes:

1. `pty.mode = "local"`:
   - persistent local shell,
   - permission-gated,
   - not sandboxed,
   - explicit warning in `/shell status`.

2. `pty.mode = "bubblewrap"`:
   - start the shell itself inside bubblewrap,
   - workspace mounted according to sandbox config,
   - network policy fixed at session start,
   - extra mounts fixed at session start.

3. `pty.mode = "off"`:
   - feature disabled.

Recommended default:

```text
pty.enabled = false
pty.mode = bubblewrap if available, else refuse unless user chooses local
```

Do not silently fall back from sandboxed PTY to local PTY.

## Workspace Isolation Interaction

If workspace isolation is active, PTY cwd must be the execution root:

```text
ctx.workspaceRoot = isolated worktree
```

The PTY session belongs to that execution root. It must be stopped when the
isolated run finalizes.

Rules:

- PTY sessions are keyed by workspace root.
- A session created in an isolated worktree is not reused in the live repo.
- Cleanup/finalize stops PTYs for disposable worktrees.

## Watch Processes

PTY sessions can run long-lived watchers:

```bash
npm run dev
npm test -- --watch
```

Add:

```text
/shell interrupt <name>
/shell send <name> <text>
```

V1 can defer arbitrary send and only support:

- Ctrl-C interrupt,
- stop session.

## Config

Add:

```json
{
  "pty": {
    "enabled": false,
    "mode": "bubblewrap",
    "defaultShell": "/bin/bash",
    "maxSessions": 2,
    "idleTimeoutMs": 900000,
    "maxTranscriptBytes": 200000,
    "commandTimeoutMs": 120000,
    "allowRunBashSessionArg": false
  }
}
```

Environment:

```bash
DEEPCODER_PTY=1
DEEPCODER_PTY_MODE=bubblewrap
```

## Tool Changes

Extend `run_bash` schema later:

```ts
session?: string
```

V1 can keep this disabled unless `pty.allowRunBashSessionArg` is true.

Slash commands are safer initial UX:

```text
/shell start [name]
/shell run <name> <command>
/shell status
/shell interrupt [name]
/shell stop [name]
```

## Transcript Handling

Persist bounded transcripts under session metadata:

```text
.deepcoder/pty/<session-id>.log
```

Rules:

- redact secrets before writing,
- cap transcript size,
- do not feed full transcript to model automatically,
- `/shell status` shows tail only,
- model sees only command output from its own tool call.

## Tests

No live model required.

1. PTY session preserves `cd`.
2. PTY session preserves exported env variable.
3. second session does not share state with first.
4. permission denied command never reaches PTY.
5. readonly mode denies PTY command.
6. timeout returns partial output and marks timedOut.
7. interrupt stops a running command.
8. stop kills child process and descendants.
9. transcript is redacted.
10. transcript is capped.
11. workspace-isolated PTY uses isolated root, not real root.
12. disposable workspace finalization stops associated PTYs.
13. bubblewrap unavailable + `mode=bubblewrap` refuses, not local fallback.
14. `/shell status` reports mode, cwd, age, last-used, sandbox state.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

Manual smoke:

```text
/shell start
/shell run default pwd
/shell run default cd src
/shell run default pwd
/shell run default export X=42
/shell run default echo $X
/shell stop
```

## Risks

### Sandbox Lifetime Drift

A long-lived sandbox has fixed mounts/network. If config changes mid-session, the
session may not reflect it.

Mitigation: show sandbox config in status and require restart after config change.

### Hidden State Makes Runs Less Reproducible

Persistent shell state can make command results depend on previous turns.

Mitigation: default off, explicit `/shell` UX, transcript/audit trail.

### Orphan Processes

Watchers and background jobs can survive if cleanup is weak.

Mitigation: PTY process group kill, finalizer on session end, tests for child
cleanup.

### Secret Exposure

Environment variables can be exported and later echoed.

Mitigation: existing redaction, transcript redaction, no automatic full transcript
injection.

## Implementation Order

1. Add PTY config/types.
2. Add session manager with fake adapter tests.
3. Add real PTY adapter (`node-pty` or child-shell fallback).
4. Add `/shell start/status/stop`.
5. Add `/shell run` with permission/hook gating.
6. Add transcript redaction/capping.
7. Add workspace-isolation cleanup integration.
8. Add optional `run_bash.session` behind config.
9. Run full gate and manual smoke.

## Definition of Done

- Persistent shell state works when explicitly enabled.
- Commands still pass through permission and hook gates.
- PTY sessions are bounded, auditable, redacted, and killable.
- Workspace-isolated PTYs cannot leak into the live repo.
- One-shot `run_bash` remains unchanged by default.
