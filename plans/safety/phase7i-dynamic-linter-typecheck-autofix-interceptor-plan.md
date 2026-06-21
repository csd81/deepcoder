# Deepcoder Phase 7I - Dynamic Linter / Type-Check Auto-Fix Interceptor

## Context

Deepcoder currently learns about syntax/type/lint errors mainly through:

- configured `/check`,
- `--solve --check`,
- local-bench checks,
- delegated worker `--check phase`,
- user-run tests.

That is often too slow. A full test suite or containerized benchmark may take
minutes just to report a trivial syntax error introduced by the previous
`edit_file` or `write_file`.

Phase 7I adds a post-write linter/type-check interceptor. After the agent
modifies a file, Deepcoder can run a fast, configured diagnostic command and
feed bounded diagnostic output back immediately, before expensive checks.

## Goal

Run fast diagnostics immediately after file writes and surface syntax/type/lint
errors to the agent in the same turn.

```text
edit_file/write_file
  -> file changed
  -> run matching fast diagnostic
  -> diagnostic result appended as tool result / notice
  -> agent fixes before slow tests
```

## ROI

High.

Why it helps:

- catches semicolon/brace/import/type mistakes immediately,
- saves slow container/test cycles,
- improves delegated-worker self-verification,
- reduces solve-loop attempts,
- gives the model precise error output close to the edit that caused it.

## Non-Goals

- Do not automatically modify code using formatter/linter fixers in v1.
- Do not run full test suites after every write.
- Do not let the model choose the diagnostic command.
- Do not bypass command classifier/sandbox.
- Do not block all edits permanently if diagnostics fail; feed back and continue.

## Design

Add a post-write diagnostic interceptor that runs after successful mutate tools:

- `edit_file`,
- `write_file`,
- future delete/rename tools.

Initial behavior:

- advisory, not blocking,
- one diagnostic per affected file group per turn,
- bounded and redacted,
- result is fed back as an additional tool result or notice.

Later behavior:

- optional blocking mode for delegated workers,
- optional auto-fix command mode after explicit design.

## Config

Add:

```json
{
  "diagnostics": {
    "enabled": false,
    "mode": "advisory",
    "maxPerTurn": 2,
    "timeoutMs": 120000,
    "rules": [
      {
        "name": "ts",
        "match": ["**/*.ts", "**/*.tsx"],
        "command": "npm run typecheck",
        "debounceMs": 250
      },
      {
        "name": "python",
        "match": ["**/*.py"],
        "command": "python -m py_compile {files}",
        "debounceMs": 250
      }
    ]
  }
}
```

Environment:

```bash
DEEPCODER_DIAGNOSTICS=1
```

Defaults:

- disabled initially,
- local project config opts in,
- local-bench/delegation can enable in controlled runs.

## Diagnostic Rule Matching

Rule fields:

```ts
interface DiagnosticRule {
  name: string;
  match: string[];
  command: string;
  timeoutMs?: number;
  debounceMs?: number;
  maxOutputBytes?: number;
}
```

Use simple glob matching over workspace-relative affected paths. If no glob
library exists, implement conservative suffix/prefix matching first:

- `**/*.ts` -> `.ts`,
- `src/**` -> path prefix.

No shell interpolation except controlled placeholders:

```text
{files}
```

`{files}` expands to shell-quoted workspace-relative affected files. If safe
quoting is not implemented in v1, disallow `{files}` and require whole-project
commands like `npm run typecheck`.

## Execution

Use existing check infrastructure:

- `classifyCommand`,
- `wrapCommand`,
- `runBoundedProcess`,
- redaction,
- timeout,
- process group kill.

Preferred implementation:

```text
src/diagnostics/types.ts
src/diagnostics/matcher.ts
src/diagnostics/runner.ts
```

Core API:

```ts
export async function runPostWriteDiagnostics(input: {
  workspaceRoot: string;
  affectedPaths: string[];
  config: DiagnosticsConfig;
  sandbox?: SandboxConfig;
  signal: AbortSignal;
  onData?: (chunk: string) => void;
}): Promise<DiagnosticRun[]>;
```

## Agent Loop Integration

After a mutating tool succeeds:

1. collect `invocation.affectedPaths`,
2. run matching diagnostic rules,
3. append diagnostic summary to the model as a tool result or notice,
4. persist diagnostic run metadata.

Important: avoid recursive tool semantics. Diagnostics are not model tool calls;
they are harness-generated post-write feedback.

Example feedback:

```text
Post-write diagnostic "typecheck" failed:
src/foo.ts:12:5 - error TS2304: Cannot find name 'parseConfig'.

This was run automatically after editing src/foo.ts. Fix the diagnostic before
running slower tests.
```

## Interaction With Hooks

This feature resembles a PostToolUse hook, but it should be first-class because:

- it needs structured affected paths,
- it needs bounded summaries fed to the agent,
- it should be part of solve/delegation telemetry,
- it must avoid arbitrary project hook execution by default.

Hooks remain user-extensible. Diagnostics are deterministic config-driven
engine checks.

## Interaction With Solve Loop

In `--solve`:

- diagnostics run inside each attempt after writes,
- diagnostic failures do not consume a full check attempt by themselves,
- if diagnostics fail, the agent sees them before the expensive configured check,
- configurable option: skip expensive check when diagnostics fail.

Initial v1:

```text
diagnostic fails -> still run configured check
```

Follow-up:

```text
diagnostic fails -> short-circuit expensive check and retry
```

## Interaction With Delegated Workers

For delegated workers:

- diagnostics run in the isolated worker worktree,
- results stored in `WorkerRun`,
- `/delegate review` shows diagnostic status,
- apply can optionally refuse if diagnostics failed.

Initial v1:

- advisory only.

## Data Model

```ts
interface DiagnosticRun {
  name: string;
  command: string;
  affectedPaths: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  logPath?: string;
  summary: string;
}
```

Persist under:

```text
.deepcoder/diagnostics/<run-id>.log
```

## Safety

- command is config-defined, not model-defined,
- command still classifier-gated,
- command runs through sandbox when available,
- output is redacted/capped,
- no network by default if sandbox supports it,
- no auto-fix in v1,
- diagnostics never write files unless the configured command itself does; docs
  should recommend read-only commands (`tsc --noEmit`, `eslint`, `flake8`,
  `py_compile`).

## Tests

No live model required.

1. matching `.ts` file triggers TS diagnostic rule.
2. non-matching file triggers no diagnostic.
3. multiple writes in one tool invocation dedupe rules.
4. maxPerTurn limits diagnostics.
5. diagnostic command denied by classifier is skipped/refused safely.
6. failed diagnostic returns bounded summary.
7. passing diagnostic returns concise success.
8. timed-out diagnostic is killed and reported.
9. secret-shaped diagnostic output is redacted.
10. diagnostic runs in isolated workspace root, not live root.
11. mutate tool success triggers diagnostics.
12. mutate tool failure does not trigger diagnostics.
13. solve loop receives diagnostic feedback before slow check.
14. delegated worker run records diagnostic metadata.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

Manual smoke:

1. Enable diagnostics for `*.ts` with `npm run typecheck`.
2. Introduce a TypeScript error through `edit_file`.
3. Confirm diagnostic output is surfaced immediately.
4. Fix the error.
5. Confirm diagnostic passes.

## Risks

### Too Slow

`npm run typecheck` can be slow in large repos.

Mitigation:

- opt-in,
- maxPerTurn,
- debounce,
- allow focused commands where available.

### Noisy Diagnostics

Whole-project typechecks may report unrelated existing errors.

Mitigation:

- include affected paths in summary,
- allow per-rule output filtering later,
- advisory-only v1.

### Unsafe Commands

Project config could define a mutating diagnostic.

Mitigation:

- command classifier gate,
- sandbox,
- trust-gate config where applicable,
- docs recommend no-write commands.

## Implementation Order

1. Add diagnostics config types and parser.
2. Add matcher and pure tests.
3. Add diagnostic runner using `runBoundedProcess`.
4. Wire post-mutate hook in `agentLoop`.
5. Add diagnostic summaries to tool result/notice.
6. Persist diagnostic logs.
7. Add solve/delegate metadata later if scope allows.
8. Add adversarial tests.
9. Document config examples.
10. Run full gate.

## Definition of Done

- Post-write diagnostics can run immediately after successful edits.
- The agent sees bounded diagnostic failures before slow checks.
- Diagnostics are config-defined, sandboxed, redacted, and capped.
- No auto-fix/mutation is performed by the interceptor in v1.
- Existing tests and command behavior remain unchanged when disabled.
