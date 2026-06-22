# Phase 10Q — `/debug-config` Effective Config Inspector

## Context

Deepcoder's configuration now has many layers:

- hardcoded defaults
- `.deepcoder/config.json`
- provider-specific environment variables
- `DEEPCODER_*` environment variables
- CLI flags
- session-local toggles from slash commands
- trust gates that intentionally neutralize MCP/hooks in untrusted workspaces
- provider-specific normalization such as OpenRouter free-model constraints

When behavior surprises the user, `/doctor` can say something is wrong and `/permissions` can summarize safety posture, but neither explains **why this exact effective value won**. The next highest-ROI missing slash command is `/debug-config`: an inspectable provenance report for effective configuration.

## Goal

Add:

```text
/debug-config
/debug-config --json
/debug-config <section>
/debug-config why <key>
```

It should answer:

- what is the effective value?
- which layer provided it?
- what lower-priority values were overridden?
- was any config ignored, normalized, or disabled by trust policy?
- what env var or config path controls it?

## Non-Goals

- No config mutation.
- No `.env` editing.
- No provider API call.
- No web lookup.
- No MCP/hook/plugin/check execution.
- No raw secret display.
- No exhaustive dump of every environment variable.

## UX

Default summary:

```text
/debug-config

Config provenance
  provider              deepseek             env: DEEPCODER_PROVIDER
  model                 deepseek-chat        env: DEEPSEEK_MODEL
  approvalMode          ask                  default
  sandbox.mode          fast                 .deepcoder/config.json
  sandbox.network       off                  default
  mcpServers            0                    trust-gate disabled workspace MCP
  hooks.enabled         false                trust-gate disabled workspace hooks
  web.enabled           false                default

Use /debug-config why <key> for details.
```

Explain one key:

```text
/debug-config why sandbox.mode

sandbox.mode = fast
winner: .deepcoder/config.json → sandbox.mode
precedence:
  CLI --sandbox             unset
  env DEEPCODER_SANDBOX     unset
  file sandbox.mode         fast
  default                   fast
notes:
  backend resolves to bubblewrap
```

JSON:

```json
{
  "entries": [
    {
      "key": "provider",
      "value": "deepseek",
      "redacted": false,
      "source": "env",
      "sourceRef": "DEEPCODER_PROVIDER",
      "candidates": [
        { "source": "env", "sourceRef": "DEEPCODER_PROVIDER", "present": true, "wins": true },
        { "source": "default", "present": true, "wins": false }
      ]
    }
  ],
  "warnings": []
}
```

Secret values:

```text
apiKey                <set>                env: DEEPCODER_API_KEY
```

Never print the key value, prefix, suffix, length, or hash.

## Design

### 1. Config provenance model

New file: `src/config/debugConfig.ts`

```ts
export type ConfigSource =
  | "default"
  | "file"
  | "env"
  | "cli"
  | "session"
  | "trust-gate"
  | "normalized";

export interface ConfigCandidate {
  source: ConfigSource;
  sourceRef: string;
  present: boolean;
  wins: boolean;
  value?: string | number | boolean | null;
  redacted?: boolean;
}

export interface DebugConfigEntry {
  key: string;
  value: string | number | boolean | null;
  redacted: boolean;
  source: ConfigSource;
  sourceRef: string;
  candidates: ConfigCandidate[];
  notes?: string[];
}

export interface DebugConfigReport {
  entries: DebugConfigEntry[];
  warnings: string[];
}
```

Formatter:

```ts
export function formatDebugConfig(report: DebugConfigReport, opts?: { section?: string }): string;
export function formatDebugConfigWhy(report: DebugConfigReport, key: string): string;
```

### 2. Provenance collector

Export:

```ts
export interface BuildDebugConfigInput {
  config: Config;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  cliOverrides?: Record<string, unknown>;
  sessionOverrides?: Record<string, unknown>;
  loadFileConfig?: typeof loadFileConfig;
  isWorkspaceTrusted?: (root: string) => boolean;
}

export function buildDebugConfig(input: BuildDebugConfigInput): DebugConfigReport;
```

Initial keys:

- provider
- model
- apiKey presence
- baseUrl
- temperature
- reasoningEffort
- reasonerModel
- subagentModel
- approvalMode
- maxTurns
- contextBudgetTokens
- compactAt
- checkpoints
- sandbox.mode
- sandbox.network
- sandbox.fallback
- workspaceIsolation.mode
- mcpServers count
- mcpExecuteEnabled
- hooks.enabled
- diagnostics.enabled
- context.instructionGraph
- context.preflight
- skills.enabled
- skills.trustWorkspaceSkills
- dependencyHealing.enabled
- dependencyHealing.network
- delegate.qualityGate.enabled
- delegate.acceptanceFirst.enabled
- delegate.autopilot.enabled
- testTargeting.enabled
- testTargeting.mode
- semanticSearch.enabled
- web.enabled
- web.searchProvider
- telemetry.statusline
- telemetry.costs
- models.roles count

Important: v1 does not need every field in `Config`; it needs the fields users most often ask about.

### 3. Provenance strategy

The current `loadConfig` computes effective values directly. Retrofitting full provenance into it would be invasive. For v1:

- Re-read `.deepcoder/config.json` through `loadFileConfig`.
- Read relevant env vars from injected `env`.
- Read effective values from `config`.
- Reconstruct candidate precedence for each supported key.

This is not perfect for every nested field, but it is deterministic, cheap, and good enough to explain common surprises.

Future deeper version:

- expose `loadConfigWithTrace()` from `src/config/config.ts`
- have normal config loading produce a real trace as it resolves each field

### 4. Trust-gate reporting

`loadConfig` disables MCP servers and hooks when the workspace is not trusted. `/debug-config` should report this explicitly:

```text
mcpServers = 0
winner: trust-gate
note: workspace is not trusted; .deepcoder/config.json MCP servers were ignored
```

To do this, compare:

- file config had MCP/hooks
- `isWorkspaceTrusted(workspaceRoot)` false
- effective config has empty MCP/hooks disabled

### 5. Session-local overrides

Some slash commands mutate session config directly:

- `/mode`
- `/sandbox`
- `/hooks`
- future `/model`
- future `/effort`
- future `/permissions`

`/debug-config` should accept an optional `sessionOverrides` object from the REPL context or infer known live differences by comparing loaded config to `session.config`.

In v1:

- show source `session` for fields whose effective value differs from a fresh `loadConfig()` under the same env and file config
- do not persist anything

### 6. Slash command

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "debug-config":
  await runDebugConfigSlash(session, arg);
  return { consumed: true };
```

Parsing:

- no args: text summary
- `--json`: full JSON
- `<section>`: filter keys by prefix/section (`provider`, `sandbox`, `web`, `delegate`, etc.)
- `why <key>`: detailed candidate chain for one key

Invalid key:

```text
Unknown config key "foo". Use /debug-config to list keys.
```

### 7. Help and slash catalog

Edit if present:

- `src/cli/slashCatalog.ts`
- `/help` text in `src/cli/slashCommands.ts`

Add:

```text
/debug-config [section|why <key>|--json]  explain effective config and precedence
```

## Safety

- API keys and secret-like values are represented only as `<set>` or `<unset>`.
- Do not print env var values for any key matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, `COOKIE`.
- Do not print `.env` file contents.
- Do not execute hooks, checks, plugins, MCP servers, web fetches, or model calls.
- JSON output must be secret-safe too.
- Output is bounded and sorted deterministically.

## Tests

New file: `test/adversarial/debug-config.test.ts`

Pure collector tests:

1. provider from env beats default.
2. file sandbox.mode beats default.
3. env sandbox mode beats file.
4. CLI/session override is shown as winning when supplied.
5. api key is shown only as `<set>`, never value/length/hash.
6. provider-specific key source is shown without leaking value.
7. trust gate reports MCP disabled when workspace untrusted.
8. trust gate reports hooks disabled when workspace untrusted.
9. web enabled env var is traced.
10. delegate acceptance-first env var is traced.
11. unknown/unsupported fields are omitted, not thrown.
12. formatter is deterministic and bounded.

Slash tests:

13. `/debug-config` prints summary.
14. `/debug-config --json` parses as JSON and has no secrets.
15. `/debug-config sandbox` filters sandbox keys.
16. `/debug-config why sandbox.mode` prints candidate chain.
17. `/debug-config why missing.key` returns clear error.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/debug-config.test.ts
```

Manual smoke:

```text
/debug-config
/debug-config --json
/debug-config provider
/debug-config why provider
/debug-config why sandbox.mode
```

Expected:

- output explains effective values and sources
- no secret value appears
- no commands or model calls run
- untrusted workspace MCP/hooks neutralization is visible

## Delegation Suitability

Good split:

1. Worker A: pure `src/config/debugConfig.ts` + tests.
2. Parent/manual: slash command wiring in `slashCommands.ts`.

Reason: provenance reconstruction is pure and testable. The slash command is small but touches the large shared command file.

Suggested worker prompt:

```text
Implement Phase 10Q debug-config core only.
Touch only:
- src/config/debugConfig.ts
- test/adversarial/debug-config.test.ts
Do not wire slash commands yet.
Do not print secrets.
Do not execute hooks, checks, MCP, plugins, web, or model calls.
Run npm run test:phase.
```

## Implementation Order

1. Add provenance types and formatter.
2. Add collector for provider/model/secrets/sandbox/web/delegate/trust-gate fields.
3. Add pure tests.
4. Wire `/debug-config`, `--json`, section filter, and `why`.
5. Add help/catalog entry.
6. Run full gate.
7. Later: replace reconstructed provenance with `loadConfigWithTrace()`.
