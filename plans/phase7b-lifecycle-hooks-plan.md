# Deepcoder Phase 7B — Lifecycle Hooks

## Goal

Add deterministic lifecycle hooks so users can customize Deepcoder behavior without changing core code.

Hooks should support workflows like:

- format files after edits,
- block protected operations before tool execution,
- audit tool calls,
- inject context at session start,
- run checks after solve attempts,
- notify when approval is needed.

## Cross-Tool Learnings

This plan incorporates lessons from Codex, Gemini CLI, and Claude Code.

### Codex

Codex supports lifecycle hooks through `/hooks`, `hooks.json`, inline config, user/project config layers, and plugin-bundled hooks. Project-local hooks are tied to project trust. Hook events include tool use, permission requests, compaction, session start, subagent start/stop, prompt submit, and stop events.

Lessons for Deepcoder:

- Add a `/hooks` browser/status command.
- Support user and project hook sources later.
- Do not run project hooks unless explicitly enabled/trusted.
- Plugin-bundled hooks can wait until Deepcoder has plugins.
- Hook trust matters as much as hook syntax.

### Gemini CLI

Gemini CLI hooks are synchronous scripts/programs that run at specific agent loop points. Hooks receive JSON on stdin and must emit JSON on stdout. Plain stdout pollution is treated as failure/noise. Exit codes have clear behavior: success, hard block, warning. Gemini also emphasizes security risk because hooks execute arbitrary code.

Lessons for Deepcoder:

- Hooks should receive strict JSON on stdin.
- Hook stdout should be parseable JSON only.
- Hook stderr is for logs/debugging.
- Exit code `2` should mean a hard block for pre-events.
- Other nonzero exits should warn and continue where safe.
- Hooks must be sandbox-aware.

### Claude Code

Claude Code has a rich lifecycle event model, matcher groups, command/HTTP/MCP/prompt/agent hooks, exec-form command hooks, path placeholders, hook browsers, and examples for notifications, formatting, protected files, and context reinjection. Claude also distinguishes pre-tool blocking from post-tool advisory behavior.

Lessons for Deepcoder:

- Start with command hooks only.
- Implement matcher groups.
- Prefer exec-form support later to avoid shell quoting issues.
- Pre-hooks may block.
- Post-hooks should warn, not crash.
- Add event-specific payloads.
- Keep the first event set small.

## Dependency

Implement after or alongside Phase 7A sandboxing.

Reason:

```text
hooks execute commands
commands need sandboxing
```

For v1, hooks may exist behind explicit enablement, but they should be run through `SandboxRunner` once Phase 7A exists.

## Config

Add to `.deepcoder/config.json`:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "name": "block-rm",
          "matcher": "run_bash",
          "command": "node .deepcoder/hooks/block-rm.js",
          "timeoutMs": 10000
        }
      ],
      "PostToolUse": [
        {
          "name": "format-after-edit",
          "matcher": "edit_file|write_file",
          "command": "npm run format -- --changed",
          "timeoutMs": 30000
        }
      ]
    }
  }
}
```

Default:

```text
hooks.enabled = false
```

Project hooks require explicit enablement.

## V1 Events

Keep the first version small:

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
PostToolFailure
PostCheck
SolveAttemptEnd
SessionEnd
```

Out of scope for v1:

```text
PermissionRequest
PreCompact
PostCompact
SubagentStart
SubagentStop
FileChanged
ConfigChange
HTTP hooks
MCP tool hooks
prompt/model hooks
agent hooks
async hooks
```

## Hook Input

Command hooks receive JSON on stdin.

Common payload:

```json
{
  "event": "PreToolUse",
  "sessionId": "2026-...",
  "workspaceRoot": "/repo",
  "cwd": "/repo",
  "mode": "auto"
}
```

Tool event payload:

```json
{
  "event": "PreToolUse",
  "sessionId": "2026-...",
  "workspaceRoot": "/repo",
  "cwd": "/repo",
  "mode": "auto",
  "tool": {
    "name": "run_bash",
    "kind": "execute",
    "description": "$ npm test",
    "input": {
      "command": "npm test"
    }
  }
}
```

Check event payload:

```json
{
  "event": "PostCheck",
  "sessionId": "2026-...",
  "workspaceRoot": "/repo",
  "check": {
    "name": "unit",
    "exitCode": 1,
    "timedOut": false,
    "runId": "..."
  }
}
```

Solve event payload:

```json
{
  "event": "SolveAttemptEnd",
  "sessionId": "2026-...",
  "workspaceRoot": "/repo",
  "solve": {
    "attempt": 2,
    "maxAttempts": 3,
    "checkPassed": false,
    "checkRunId": "..."
  }
}
```

## Hook Output

Require JSON on stdout when output is present. Logs go to stderr.

Pre-event examples:

```json
{ "decision": "allow" }
```

```json
{
  "decision": "deny",
  "reason": "Protected command blocked"
}
```

```json
{
  "decision": "warn",
  "message": "Formatting recommended"
}
```

Post-event example:

```json
{
  "message": "Formatted changed files"
}
```

Optional context injection for selected events:

```json
{
  "context": "Remember: use python -m pytest for this repo."
}
```

Context injection should be allowed only for:

```text
SessionStart
UserPromptSubmit
PostCheck
SolveAttemptEnd
```

## Exit Code Rules

Simplified Codex/Gemini/Claude-inspired behavior:

```text
0 = parse stdout JSON if present
2 = hard block for pre-events
other = warning, continue
```

For post-events:

```text
nonzero = warning only
```

Broken post-hooks must not crash the agent.

## Matcher Rules

V1 matcher:

```text
empty or "*" = all
"a|b" = exact alternatives
otherwise = JavaScript regex
```

For tool events, match against tool name:

```text
run_bash
edit_file
write_file
mcp__server__tool
```

Later:

```text
run_bash(git push *)
edit_file(*.ts)
```

## Hook Runner

New files:

```text
src/hooks/types.ts
src/hooks/config.ts
src/hooks/matcher.ts
src/hooks/runner.ts
src/hooks/events.ts
```

`runner.ts` responsibilities:

- select matching hooks,
- run command with JSON stdin,
- apply timeout,
- redact stdout/stderr,
- parse JSON stdout,
- return decisions,
- write audit records.

## Sandbox Integration

Once Phase 7A exists:

```ts
sandboxRunner.run(hook.command, {
  cwd,
  workspaceRoot,
  network,
  timeoutMs,
  stdin: JSON.stringify(payload)
})
```

Before sandbox exists:

- hooks disabled by default,
- project hooks require `hooks.enabled = true`,
- warn that hooks are unsandboxed,
- allow only project-local hook paths under `.deepcoder/hooks/` if implementing before Phase 7A.

## Where To Fire Hooks

`SessionStart`

- after config/session load.

`UserPromptSubmit`

- before adding user message.

`PreToolUse`

- before permission approval/execution.
- may deny.

`PostToolUse`

- after successful tool result.

`PostToolFailure`

- after failed tool result.

`PostCheck`

- after `/check` or solve-loop check run.

`SolveAttemptEnd`

- after each solve attempt.

`SessionEnd`

- on REPL exit or one-shot completion.

## Security Rules

- Hooks disabled by default.
- Project hooks require explicit enablement/trust.
- Hook commands must not receive secrets unless explicitly configured.
- Secrets passed only through env when needed, never command strings.
- Redact hook stdout/stderr in logs.
- Hook stdout must be JSON.
- Prefer exec form later; v1 command string is acceptable if sandboxed.
- Do not support HTTP hooks in v1.
- Do not support model/prompt hooks in v1.
- Do not let hooks override core permission denials.
- Hooks may deny, warn, or add context; they may not bypass policy.

## Slash Command

Add:

```text
/hooks
```

Shows:

```text
enabled: true
source: .deepcoder/config.json

PreToolUse
  block-rm     matcher=run_bash     command=node .deepcoder/hooks/block-rm.js

PostToolUse
  format       matcher=edit_file|write_file
```

Optional:

```text
/hooks disable
/hooks enable
```

Status-only is enough for v1.

## Adversarial Tests

1. `PreToolUse` deny blocks `run_bash`.
2. `PreToolUse` allow does not bypass normal permissions.
3. Broken JSON stdout becomes warning, not crash.
4. Exit code `2` blocks pre-event.
5. Post-event failure warns only.
6. Matcher exact and regex behavior.
7. Hook timeout kills process.
8. Secrets in hook output are redacted.
9. Hook command cannot run when hooks disabled.
10. Hook cannot approve denied dangerous command.

Important rule:

```text
Hooks may deny, warn, or add context.
Hooks may not override core permission denials.
```

## Acceptance

```bash
npm run typecheck
npm run test:phase
```

Manual smoke:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "name": "deny-bash",
          "matcher": "run_bash",
          "command": "node .deepcoder/hooks/deny.js"
        }
      ]
    }
  }
}
```

Then ask Deepcoder to run bash:

```text
hook denies
model receives denial reason
session continues
```

## Out Of Scope

- HTTP hooks.
- MCP tool hooks.
- LLM/prompt hooks.
- Agent hooks.
- async/background hooks.
- hook marketplace/plugins.
- UI hook editor.
- full Codex/Gemini/Claude event matrix.

## Implementation Order

1. Add hook config schema.
2. Add matcher.
3. Add command hook runner.
4. Fire `PreToolUse`.
5. Fire `PostToolUse` / `PostToolFailure`.
6. Fire `PostCheck` and `SolveAttemptEnd`.
7. Add `/hooks` status.
8. Add adversarial tests.
9. Add README/ROADMAP.
10. Route hooks through `SandboxRunner` from Phase 7A.
