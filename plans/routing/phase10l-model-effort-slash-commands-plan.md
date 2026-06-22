# Phase 10L — `/model` and `/effort` Slash Commands

## Context

Deepcoder already has a Phase 10F model router and a read-only `/models` command that prints the effective routing table. That is useful for inspection, but not enough for daily use. Users need a quick way to switch the active model or reasoning effort for the current session without editing `.deepcoder/config.json`, exporting environment variables, or restarting.

The next highest-ROI missing slash command family is:

- `/model` — inspect and session-locally override the model route for a role.
- `/effort` — inspect and session-locally override reasoning effort for routes that support it.

This is primarily a cost-control and debugging feature. It lets the user quickly move planning to a reasoner, editing to a cheaper model, review to a stricter model, or lower reasoning effort during exploratory work.

## Goal

Add session-local model routing controls:

```text
/model
/model <role>
/model <role> <provider>/<model>
/model <role> <model>
/model reset <role>
/model reset all

/effort
/effort <low|medium|high>
/effort <role> <low|medium|high>
/effort reset <role>
/effort reset all
```

The commands should mutate only in-memory session routing state by default. They should not rewrite `.deepcoder/config.json`.

## Non-Goals

- No provider API call just to validate a model.
- No web lookup of model names.
- No automatic selection of "best" model.
- No pricing optimization logic; that belongs to model/task routing.
- No editing `.deepcoder/config.json`.
- No changes to tool permissions.
- No cross-session persistence in v1.

## UX

Current state:

```text
/model

Model routes:
  edit          deepseek/deepseek-chat        [default]
  plan          deepseek/deepseek-reasoner    [file]
  review        openrouter/qwen/qwen3-coder:free [session]
  delegate      deepseek/deepseek-chat        [default]

Use: /model <role> <provider>/<model>
```

Inspect one role:

```text
/model plan
plan: deepseek/deepseek-reasoner [file] · effort medium
fallbacks: fallback
```

Set one role:

```text
/model review openrouter/qwen/qwen3-coder:free
review route set for this session: openrouter/qwen/qwen3-coder:free
```

If provider is omitted, keep the currently resolved provider for that role:

```text
/model edit deepseek-v4-flash
edit route set for this session: deepseek/deepseek-v4-flash
```

Effort:

```text
/effort
global reasoning effort: medium
session overrides: none

/effort high
default reasoning effort set for this session: high

/effort plan low
plan effort set for this session: low
```

Reset:

```text
/model reset review
/effort reset all
```

## Design

### 1. Session-local route overrides

New file: `src/models/sessionOverrides.ts`

```ts
export interface SessionModelOverride {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface SessionModelOverrides {
  roles: Partial<Record<ModelRole, SessionModelOverride>>;
  defaultReasoningEffort?: "low" | "medium" | "high";
}
```

Functions:

```ts
export function emptySessionModelOverrides(): SessionModelOverrides;
export function parseModelTarget(input: string): { provider?: string; model: string };
export function applyModelOverride(...): SessionModelOverrides;
export function applyEffortOverride(...): SessionModelOverrides;
export function clearModelOverride(...): SessionModelOverrides;
export function clearEffortOverride(...): SessionModelOverrides;
```

Rules:

- Role names must be one of `ALL_ROLES`.
- Model string must be non-empty and bounded.
- Provider string may be omitted.
- No shell-sensitive or control characters in provider/model.
- OpenRouter free-model policy remains provider-specific: if provider is `openrouter`, normalize only via the existing OpenRouter provider behavior, not globally.

### 2. Router support for session overrides

Edit: `src/models/router.ts`

Current precedence comment says CLI override is "future". Implement session override as the actual highest precedence:

1. Session override
2. Environment variable
3. File config
4. Default

The `ModelRouter` constructor currently accepts `config` and file models. Add an optional `sessionOverrides` parameter:

```ts
constructor(config: Config, fileModels?: ModelsFileConfig, sessionOverrides?: SessionModelOverrides)
```

`resolveFromSession(role)`:

- starts from lower-precedence route to fill omitted fields
- applies provider/model/baseUrl/temperature/reasoningEffort
- source is `"cli"` or a new `"session"` source

Prefer adding `"session"` to `ResolvedModelRoute.source` if downstream display wants clarity. If that is too broad, reuse `"cli"` and label it "session override" in slash output.

### 3. Session state

Edit: `src/cli/repl.ts`

Add to `Session`:

```ts
modelOverrides: SessionModelOverrides;
```

When constructing `session.modelRouter`, pass `session.modelOverrides`.

Important nuance: if `ModelRouter` stores overrides by reference, slash commands can mutate `session.modelOverrides` and future resolves pick it up. If it copies the value, rebuild `session.modelRouter` after `/model` or `/effort`.

Do not persist this field in v1. It is an active-session control.

### 4. Slash command implementation

Edit: `src/cli/slashCommands.ts`

Add cases:

```ts
case "model":
  await runModelSlash(session, arg);
  return { consumed: true };

case "effort":
  await runEffortSlash(session, arg);
  return { consumed: true };
```

Parsing should be simple and explicit:

- `/model` prints all routes.
- `/model <role>` prints one resolved role.
- `/model <role> <target>` sets session override.
- `/model reset <role|all>` clears override.
- `/effort` prints global/default + role overrides.
- `/effort <level>` sets default session effort.
- `/effort <role> <level>` sets role effort.
- `/effort reset <role|all>` clears effort override.

Invalid input prints usage and does not mutate state.

### 5. Provider pool interaction

Deepcoder uses `session.modelRouter` and `session.providerPool` for routed calls. After an override:

- ensure future provider acquisition resolves through the updated route
- do not mutate already-in-flight calls
- do not clear token usage
- do not reset conversation history

If `ProviderPool` caches by route key, it should naturally create a new provider for the new route. If it caches too broadly, add a route-key check or `session.providerPool.clearRole(role)` in a follow-up.

### 6. Existing `/models` command

Keep `/models` as the read-only table. Update it to show session overrides clearly:

```text
review        openrouter/qwen/qwen3-coder:free [session]
```

Optionally print:

```text
Use /model <role> <provider>/<model> to override for this session.
```

## Safety

- Slash commands never print API keys.
- No provider validation call.
- No web call.
- No config-file write.
- No model names from untrusted command output.
- Provider/model strings are bounded and reject control characters.
- OpenRouter free-model enforcement stays in OpenRouter provider logic only.
- If user selects a bad model, the next actual model call may fail normally; `/doctor` can later diagnose.

## Tests

New file: `test/adversarial/model-slash.test.ts`

Pure tests:

1. `parseModelTarget("openrouter/qwen/qwen3-coder:free")` returns provider + model.
2. `parseModelTarget("deepseek-chat")` returns model only.
3. Control characters are rejected.
4. Unknown role is rejected.
5. Invalid effort is rejected.
6. Reset one role preserves other overrides.
7. Reset all clears every override.

Router tests:

8. Session override beats env/file/default.
9. Partial override with only model preserves current provider/baseUrl.
10. Effort override applies to the selected role.
11. Default session effort applies when a role has no specific effort.
12. `/models` explanation marks session override source.

Slash tests:

13. `/model` prints table without mutating.
14. `/model review openrouter/qwen/qwen3-coder:free` changes only review route.
15. `/effort plan high` changes only plan effort.
16. Invalid usage returns a bounded usage string and leaves state unchanged.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/model-slash.test.ts
```

Manual smoke:

```text
/models
/model review openrouter/qwen/qwen3-coder:free
/models
/effort plan high
/model plan
/model reset review
/effort reset all
```

Expected:

- session route changes are visible immediately
- no `.deepcoder/config.json` diff
- no provider API call happens during slash command
- invalid model names are not accepted if they contain control characters
- route source clearly shows session override

## Delegation Suitability

Medium-risk delegated slice:

- mostly pure parsing/router logic
- one shared integration point in `Session`
- one shared slash-command file

Recommended split:

1. Worker A: pure `sessionOverrides.ts` + tests.
2. Worker B: router precedence support + tests.
3. Parent/manual: `slashCommands.ts` + `repl.ts` wiring, because these are shared hot files.

If delegated as one task, require `--check phase` and review carefully for accidental config persistence.

## Implementation Order

1. Add `src/models/sessionOverrides.ts`.
2. Add pure parser/override tests.
3. Extend `ResolvedModelRoute.source` if choosing `"session"`.
4. Add `ModelRouter` session override precedence.
5. Add `Session.modelOverrides` initialization.
6. Wire `/model` and `/effort`.
7. Update `/models` display.
8. Run full gate.
9. Update help text and slash catalog if present.
