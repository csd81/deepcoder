# Phase 10K — `/doctor` Healthcheck Slash Command

## Context

Deepcoder already has many powerful subsystems: providers, model routing, sandboxing, workspace isolation, checks, MCP, hooks, plugins, web tools, skills, delegation, telemetry, and TUI work. When any of these fail, the user currently has to inspect several commands and config files manually.

The highest-ROI missing slash command is `/doctor`: one deterministic healthcheck that explains whether Deepcoder is ready to run, what is misconfigured, and what concrete fix to apply. This mirrors the practical value of Codex/Claude-style diagnostic commands without adding model calls or execution authority.

## Goal

Add a read-only `/doctor` slash command that checks local runtime health and prints a bounded, human-readable report:

- config and workspace trust
- provider/model/key reachability at the configuration level
- git state
- Node/npm/toolchain availability
- sandbox backend status
- workspace isolation readiness
- checks configuration and command-policy classification
- MCP server configuration safety
- hooks configuration safety
- plugins discovery/trust summary
- web tool configuration
- delegation readiness
- telemetry/cost configuration

The first version must be deterministic, no-network, no-model, read-only, and safe to run in any repo.

## Non-Goals

- No remote provider API call.
- No web request.
- No MCP server spawn.
- No hook execution.
- No check execution.
- No plugin code execution.
- No mutation of config, sessions, plans, trust stores, or git state.
- No automatic repair. `/doctor --fix` is out of scope.

## UX

Commands:

```text
/doctor
/doctor --json
/doctor --section provider
/doctor --section sandbox
/doctor --section checks
```

Human output:

```text
Doctor: 2 errors · 3 warnings · 9 ok

ERR provider
  Missing DEEPCODER_API_KEY for provider deepseek.
  Fix: export DEEPCODER_API_KEY=... or configure provider-specific key.

WARN sandbox
  sandbox.mode=fast resolved to local because bwrap is not available.
  Fix: install bubblewrap or set DEEPCODER_SANDBOX=local intentionally.

OK checks
  3 configured checks; 0 blocked by command policy.
```

JSON output is stable and testable:

```json
{
  "ok": false,
  "summary": { "ok": 9, "warn": 3, "error": 2 },
  "checks": [
    {
      "id": "provider.key",
      "section": "provider",
      "level": "error",
      "title": "Missing provider key",
      "details": "DEEPCODER_API_KEY is not set",
      "fix": "Export DEEPCODER_API_KEY or provider-specific key"
    }
  ]
}
```

## Design

### 1. Pure diagnostics model

New file: `src/doctor/types.ts`

```ts
export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  section: string;
  level: DoctorLevel;
  title: string;
  details?: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: { ok: number; warn: number; error: number };
  findings: DoctorFinding[];
}
```

Rules:

- `error` means a requested/active capability is unusable or unsafe.
- `warn` means usable but degraded, surprising, or likely misconfigured.
- `ok` means a capability is present or intentionally disabled.

### 2. Collector core

New file: `src/doctor/doctor.ts`

Export:

```ts
export interface DoctorInput {
  workspaceRoot: string;
  config: Config;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileLike;
  fs?: FsProbeLike;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport>;
export function formatDoctorReport(report: DoctorReport): string;
```

Use injected `execFile` and probe helpers so tests never shell out unless they explicitly opt in.

Collector sections:

- `provider`
  - provider/model/baseUrl configured
  - API key presence checked by env/config only
  - never prints key or length
  - warns if model router config references unknown/empty routes

- `workspace`
  - workspace exists and is directory
  - git repo detection via `git rev-parse --show-toplevel`
  - dirty tree summary via existing `Git` helper if available
  - warns when workspace is untrusted and config contains MCP/hooks

- `runtime`
  - Node version present
  - npm/pnpm availability best-effort
  - package scripts exist for configured checks when command starts with `npm run <script>`

- `sandbox`
  - uses existing `resolveBackend` and bubblewrap probe paths
  - reports resolved backend and whether mode degraded
  - error if fail-closed config cannot resolve a backend

- `workspace-isolation`
  - mode off/patch/keep
  - warns if mode requires git but workspace is not a git repo
  - warns if dirty tree would make isolation fail

- `checks`
  - number of checks
  - classify each configured command with `classifyCommand`
  - error for denied checks
  - warn for no checks when solve/delegate features are configured

- `mcp`
  - count configured servers
  - report execute-enabled true/false
  - warn if workspace untrusted disables MCP
  - validate missing command/args shape only from loaded config

- `hooks`
  - enabled/disabled
  - count hook commands
  - classify hook commands if available
  - warn when hooks enabled in untrusted workspace

- `plugins`
  - discover plugins with `discoverPlugins`
  - summarize discovered/trusted/untrusted/malformed
  - never execute plugin contributions

- `web`
  - enabled/disabled
  - search provider configured
  - allowed/blocked domain counts
  - warn if web enabled but provider is `none`

- `delegation`
  - delegate quality gate status
  - acceptance-first status
  - worker runner prerequisites: git repo, checks configured, workspace isolation compatibility
  - warn if delegation is available but no check suitable for `--check phase`

- `telemetry`
  - costs enabled/disabled
  - pricing known/unknown for active provider/model using existing pricing helpers

### 3. Slash command

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "doctor":
  await runDoctorSlash(session, arg);
  return { consumed: true };
```

`runDoctorSlash` parses:

- `--json`
- `--section <name>`

The slash command should:

- print text report by default
- print JSON only with `--json`
- exit normally regardless of findings
- never call the model
- never run checks or hooks

### 4. Tests

New file: `test/adversarial/doctor.test.ts`

Coverage:

1. Missing provider key is an `error`, and the key value is never printed.
2. Configured provider/model with a key produces provider `ok`.
3. Denied check command is an `error`.
4. Empty checks produce a warning when solve/delegation expects a check.
5. Sandbox fail-closed backend failure is an `error`.
6. Sandbox degraded-to-local is a warning, not an error, when fallback allows it.
7. Web enabled with `searchProvider=none` is a warning.
8. Hooks enabled in an untrusted workspace produce a warning/error consistent with existing trust behavior.
9. Plugin discovery errors are reported as warnings without throwing.
10. `formatDoctorReport` is bounded, deterministic, and sorted by severity then section.
11. `--json` shape is stable and contains no secrets.
12. Section filtering only shows requested section plus summary.

### 5. Optional TUI follow-up

Out of scope for this phase, but the report shape should support a future TUI panel:

- green/yellow/red rows
- expandable details
- "copy fix" action
- direct jump to config section

## Security

- No secrets in output, logs, JSON, errors, snapshots, or thrown messages.
- No command execution except injected local probes such as `git --version` or `node --version`.
- No shell interpolation; use `execFile` only for optional probes.
- No remote network calls.
- No tool/hook/MCP/plugin execution.
- Findings are advisory. `/doctor` must not mutate config or trust decisions.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/doctor.test.ts
```

Manual smoke:

```text
deepcoder "/doctor"
deepcoder "/doctor --json"
deepcoder "/doctor --section sandbox"
```

Expected:

- `/doctor` works in a repo with no configured checks.
- `/doctor` works when `.env` is absent.
- `/doctor --json` parses with `JSON.parse`.
- No provider API request is made.
- Output never contains API-key material.

## Delegation Suitability

Good first slice for a delegated worker:

- mostly pure code
- read-only behavior
- high testability
- no provider/model call needed for acceptance

Suggested worker scope:

```text
Implement Phase 10K `/doctor` ONLY.
Touch only:
- src/doctor/types.ts
- src/doctor/doctor.ts
- src/cli/slashCommands.ts
- test/adversarial/doctor.test.ts
Do not execute hooks, MCP servers, checks, plugins, web requests, or model calls.
Run npm run test:phase.
```

## Implementation Order

1. Add `src/doctor/types.ts`.
2. Add pure collector + formatter in `src/doctor/doctor.ts` with injected probes.
3. Add adversarial tests for collector and formatter.
4. Wire `/doctor` in `slashCommands.ts`.
5. Add slash-command tests for `--json` and `--section` if current test harness supports it cleanly.
6. Run full gate.
7. Optionally add README mention after behavior is stable.
