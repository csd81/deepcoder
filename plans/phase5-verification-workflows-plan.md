# Deepcoder Phase 5 — Controlled Verification Workflows

## Context

Phases 1–4 established the core agent loop, permissions, context management, MCP read-only tools, provider abstraction, local checkpoints, and three read-only subagents:

- `/review` for bug/regression review.
- `/research` for cited codebase explanations.
- `/triage` for test/log failure diagnosis.

The obvious next capability is letting Deepcoder help verify work by running tests or checks. This must be done carefully: arbitrary execution is already the highest-risk tool class, and subagents are intentionally read-only. Phase 5 should add **user-invoked, named verification workflows**, not model-callable autonomous test execution.

## Goal

Add a safe path for the user to run configured project checks from the CLI:

```text
/checks
/check unit
/check typecheck
/check lint
```

The result should be captured, bounded, resumable for audit, and easy to pass into `/triage`, while preserving the existing permission model.

## Non-Goals

- No model-callable test runner.
- No arbitrary `/check "some shell command"` input.
- No automatic test execution after edits.
- No background task manager or long-running dev servers.
- No CI provider integration.
- No MCP execution.
- No hidden persistence into model-visible history.

## Design Principles

- Commands are configured by the user, not invented by the model.
- Execution is still permission-gated.
- Output is untrusted and quarantined by default.
- Output is bounded and redacted before storage or display.
- A failed check can be diagnosed by `/triage`, but only through an explicit user action.
- Ctrl-C must stop the process promptly.

## Config

Extend `.deepcoder/config.json`:

```json
{
  "checks": {
    "typecheck": {
      "command": "npm run typecheck",
      "timeoutMs": 120000
    },
    "unit": {
      "command": "npm run test:unit",
      "timeoutMs": 120000
    },
    "phase": {
      "command": "npm run test:phase",
      "timeoutMs": 300000
    }
  }
}
```

Rules:

- Check names: `^[a-zA-Z0-9_-]{1,40}$`.
- Commands are strings but must pass the existing command classifier.
- Denied commands are rejected at run time even if configured.
- Unknown config entries are ignored with warnings.
- Default config may infer common checks from `package.json` scripts, but only as display suggestions. Do not execute inferred commands unless explicitly configured or confirmed by the user.

## Slash Commands

### `/checks`

Lists configured checks:

```text
typecheck  npm run typecheck
unit       npm run test:unit
phase      npm run test:phase
```

If none are configured, show a short example for `.deepcoder/config.json`.

### `/check <name>`

Runs a named check.

Flow:

1. Look up the named command.
2. Classify it with the command classifier.
3. If denied, refuse.
4. If allowed/ask, show command and timeout and ask for confirmation.
5. Run in the workspace root.
6. Capture stdout/stderr combined.
7. Bound output.
8. Redact obvious secrets.
9. Persist a quarantined run record.
10. Render concise summary: exit code, duration, truncated flag, run id.

Do not append check output to `session.messages`.

### Future `/triage --run <id>`

Defer to a follow-up slice unless trivial. For this phase, print:

```text
Run /triage --file .deepcoder/runs/<id>.log to diagnose this output.
```

But note: `.deepcoder` is sensitive and read_file blocks it, so the better follow-up is a first-class `/triage --run <id>` path that reads quarantined run output without exposing arbitrary `.deepcoder` reads. Plan it, do not sneak it in unless explicitly scoped.

## Run Store

New module: `src/session/checkRuns.ts`.

Layout:

```text
.deepcoder/runs/<id>.json
.deepcoder/runs/<id>.log
```

Manifest:

```ts
interface CheckRun {
  id: string;
  name: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  logPath: string;
}
```

Rules:

- Atomic manifest writes.
- Logs capped to a fixed size. Recommendation: 256 KB.
- Logs are redacted before writing.
- `.deepcoder/runs` remains gitignored.
- Run records are not model-visible by default.

## Execution Runner

New module: `src/checks/runner.ts`.

Implementation notes:

- Use `child_process.spawn` with `shell: true` only if command-classifier coverage is considered sufficient. Prefer the same shell semantics as `run_bash` for consistency.
- Use workspace root as cwd.
- Stream output to terminal while also capturing bounded output.
- On abort, kill the process group if possible.
- Enforce timeout.
- Never throw for non-zero exit; return a structured result.
- Throw only for internal runner setup errors.

## Security / Trust Boundary

- `/check` is user-invoked only.
- The model cannot call `/check`.
- The model cannot define checks.
- Check output is untrusted data.
- Check output is quarantined from parent model history.
- Command classifier remains the gate for shell execution.
- Sensitive-looking output is redacted before persistence and display.

## Redaction

Add or reuse a central redaction helper for:

- `sk-*` tokens.
- `Bearer ...`.
- `Authorization: ...`.
- `api_key=...`.
- `token=...`.
- common private key headers.

This should reuse provider-error redaction if available, or move that logic into `src/workspace/redact.ts`.

## Adversarial Tests

Add `test/adversarial/check-runs.test.ts`.

Required coverage:

- Unknown check name does not execute.
- Denied configured command is refused.
- `curl | sh`, redirections, destructive commands, and command substitution are rejected.
- Output containing key-shaped secrets is redacted before display/storage.
- Huge output is truncated.
- Non-zero exit is stored as a failed run, not thrown.
- Timeout kills the process and records `timedOut`.
- Abort kills the process and does not continue hidden work.
- Check output never enters `session.messages`.
- Check run metadata persists separately from model-visible session history.
- `.deepcoder/runs` cannot be read through normal `read_file`.

## Normal Tests

- Config parser accepts valid checks.
- `/checks` lists configured checks.
- `/check <name>` runs a harmless command in a temp workspace.
- Run store list/load works.
- Existing command-policy tests remain green.

## Implementation Order

1. Hardening gate: verify the just-fixed read symlink and abort behavior with tests.
2. Add config schema for `checks`.
3. Add redaction helper shared by provider errors and check output.
4. Add check run store.
5. Add execution runner with timeout/abort/bounded capture.
6. Add `/checks` and `/check <name>`.
7. Add adversarial tests.
8. Update README, `.env.example` if needed, ROADMAP, and this plan status.
9. Run `npm run typecheck` and `npm run test:phase`.
10. Optional live smoke: run a harmless configured check.

## Acceptance Criteria

- `npm run typecheck` clean.
- `npm run test:phase` green.
- `/check` can only run named configured checks.
- Dangerous configured commands are denied.
- Output is bounded, redacted, and quarantined.
- Check output does not enter parent model-visible history.
- Ctrl-C and timeouts stop the child process.
- Existing `/review`, `/research`, `/triage`, checkpoints, and permissions remain green.

## Follow-Up Slice

Phase 5B should add:

```text
/triage --run <id>
```

That lets the test-triage subagent diagnose a stored check run without opening general access to `.deepcoder` internals.

Keep 5A focused on running and storing checks; keep diagnosis integration explicit and separate.
