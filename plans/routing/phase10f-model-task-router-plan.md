# Phase 10F — Model Router and Task Router

## Context

Deepcoder already has the beginnings of model routing:

- `model` for normal editing/tool use
- `reasonerModel` for `/plan` and `--plan-first`
- `subagentModel` for read-only subagents
- provider-specific defaults for DeepSeek, Gemini, Qwen, Anthropic, OpenAI-compatible, OpenAI Responses, and Ollama

Those knobs are useful but ad hoc. There is no central policy that says: planning should use a
reasoning model, editing should use the default cheap tool model, review should use a stricter
model, summarization should use a cheap small model, and fallback should degrade predictably.

This phase adds a model/task router: a single policy layer that maps internal task roles to
provider/model/runtime settings. The router should save cost, improve quality, and make routing
visible/auditable without changing the provider boundary or tool safety model.

## Goals

- Introduce named model roles: `edit`, `plan`, `review`, `research`, `summarize`, `triage`,
  `explore`, `delegate`, `qualityGate`, and `fallback`.
- Route each agent/subagent/system call through a central resolver.
- Support provider/model overrides per role.
- Support fallback chains when a role model errors or is unavailable.
- Emit routing telemetry for cost/statusline/reporting.
- Preserve existing behavior by default.

## Non-goals

- No automatic benchmarking/model selection in this phase.
- No remote model marketplace.
- No dynamic routing based on hidden provider latency/cost APIs.
- No safety policy differences by model. Permissions remain tool/session based, not model based.
- No multi-model consensus unless explicitly planned later.

## Role Model

New module:

`src/models/router.ts`

```ts
export type ModelRole =
  | "edit"
  | "plan"
  | "review"
  | "research"
  | "summarize"
  | "triage"
  | "explore"
  | "delegate"
  | "qualityGate"
  | "fallback";

export interface ModelRoute {
  role: ModelRole;
  provider?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTurns?: number;
  fallbackRoles?: ModelRole[];
  fallbackModels?: string[];
}

export interface ResolvedModelRoute {
  role: ModelRole;
  provider: string;
  model: string;
  baseUrl: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  source: "default" | "file" | "env" | "cli";
}
```

The router resolves a role to a complete provider/model config, then provider creation uses that
resolved config for the call.

## Config

Extend `.deepcoder/config.json`:

```json
{
  "models": {
    "roles": {
      "edit": { "model": "deepseek-chat" },
      "plan": { "model": "deepseek-reasoner" },
      "review": { "provider": "anthropic", "model": "claude-3-5-sonnet-latest" },
      "summarize": { "provider": "gemini", "model": "gemini-3.5-flash" }
    },
    "fallbacks": {
      "plan": ["edit"],
      "review": ["edit"],
      "summarize": ["edit"]
    }
  }
}
```

Environment overrides:

- `DEEPCODER_MODEL_EDIT`
- `DEEPCODER_MODEL_PLAN`
- `DEEPCODER_MODEL_REVIEW`
- `DEEPCODER_MODEL_RESEARCH`
- `DEEPCODER_MODEL_SUMMARIZE`
- `DEEPCODER_MODEL_TRIAGE`
- `DEEPCODER_MODEL_EXPLORE`
- `DEEPCODER_MODEL_DELEGATE`
- `DEEPCODER_MODEL_QUALITY_GATE`

Provider overrides:

- `DEEPCODER_PROVIDER_<ROLE>`
- `DEEPCODER_BASE_URL_<ROLE>`

Back-compat mapping:

- `DEEPCODER_MODEL` / `config.model` -> `edit`
- `DEEPCODER_REASONER_MODEL` / `config.reasonerModel` -> `plan`
- `DEEPCODER_SUBAGENT_MODEL` / `config.subagentModel` -> default for review/research/triage/explore unless role-specific override exists

## Defaults

Initial behavior must match current behavior:

- `edit` -> `config.model`
- `plan` -> `config.reasonerModel ?? provider default reasoner ?? edit`
- `review` -> `config.subagentModel ?? edit`
- `research` -> `config.subagentModel ?? edit`
- `triage` -> `config.subagentModel ?? edit`
- `explore` -> `config.subagentModel ?? edit`
- `delegate` -> `edit`
- `qualityGate` -> `review`
- `summarize` -> `edit` until explicitly configured
- `fallback` -> `edit`

No user-visible behavior changes without config/env/CLI opt-in.

## Provider Creation

Current `createProvider(config)` creates one provider for the whole session. A role may need a
different provider or base URL, so this phase adds a factory cache:

`src/models/providerPool.ts`

```ts
export class ProviderPool {
  constructor(baseConfig: Config);
  providerFor(route: ResolvedModelRoute): ModelProvider;
}
```

Rules:

- Cache by provider/baseUrl/apiKey prefix label, not by role.
- Never log API keys.
- Reuse existing provider adapters.
- Role-specific provider credentials use the existing per-provider env prefix rules.
- Missing key for a role provider should produce a clear route error and fall back if configured.

## Routing Integration Points

Replace direct model selection in these paths:

1. Main agent loop
   - role: `edit`
   - current `session.config.model`

2. `/plan` and `--plan-first`
   - role: `plan`
   - no tools
   - fallback to `edit` if plan model unavailable and configured

3. Subagents
   - reviewer -> `review`
   - researcher -> `research`
   - test triage -> `triage`
   - explorer/preflight -> `explore`

4. Delegated workers
   - worker child default -> `delegate`
   - parent quality/completeness gates -> `qualityGate`

5. Compaction/summarization
   - role: `summarize`
   - only when a model-based summarizer exists; current deterministic compaction remains unchanged

## Runtime API

Add to session:

```ts
modelRouter: ModelRouter;
providerPool: ProviderPool;
```

Helpers:

```ts
session.modelRouter.resolve("plan")
session.providerPool.providerFor(route)
```

Callers should pass both provider and model from the resolved route into `runAgentLoop` or
`provider.chat`.

## Fallback Semantics

Fallback only applies to model/provider setup or provider call failures that occur before a tool
call is produced. It must not silently retry mutating tool turns under a different model after the
model already emitted tool calls.

Rules:

- `/plan` can fallback freely because it has no tools.
- read-only subagents can fallback because they run readonly and isolated.
- edit turns should not fallback mid-turn by default; surface the provider error.
- solve attempts should not duplicate an edit attempt under fallback unless explicitly configured later.
- all fallback decisions are logged as telemetry notices.

## Telemetry

Every model call should record:

- role
- provider
- model
- route source
- fallback used? from/to
- usage tokens
- estimated cost when Phase 10C is available

New slash command:

```text
/models
/models explain
/models role <name>
```

Output examples:

```text
edit       deepseek/deepseek-chat          source env
plan       deepseek/deepseek-reasoner      source env fallback edit
review     anthropic/claude-3-5-sonnet     source file fallback edit
```

## Config Validation

Add zod schema in `fileConfig.ts`:

```ts
models?: {
  roles?: Record<string, ModelRouteConfig>;
  fallbacks?: Record<string, string[]>;
}
```

Validation:

- unknown role names warn and skip
- model must be non-empty string
- provider must be known if supplied
- fallback roles must be valid roles
- fallback cycles are rejected
- route count bounded

## Security

- Routing changes only model/provider choice; it never changes tool permissions.
- A stronger/cheaper model cannot gain new tools through routing.
- Role-specific provider errors must be redacted by existing provider error mapping.
- Config from untrusted workspaces follows existing trust behavior. If model routes are added to executable plugin/config later, they should be inert until trusted if they imply external data egress to a new provider.
- `/models explain` must not print API keys or full base URLs with embedded credentials.

## Files

New:

- `src/models/types.ts`
- `src/models/router.ts`
- `src/models/providerPool.ts`
- `test/adversarial/model-router.test.ts`

Edit:

- `src/config/config.ts`
- `src/config/fileConfig.ts`
- `src/cli/main.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- `src/cli/solveRunner.ts`
- `src/subagents/runner.ts`
- `src/subagents/contextExplorer.ts`
- `src/delegate/workerRunner.ts`
- `src/providers/factory.ts` only if needed to support route-shaped config
- `src/session/sessionStore.ts` if route telemetry is persisted

## Tests

No live model required.

1. Defaults preserve current `edit`, `plan`, and `subagent` behavior.
2. Role-specific env override beats file/default.
3. File route provider/model parses and resolves.
4. Unknown role/provider warns and skips.
5. Fallback cycle is rejected.
6. `/plan` uses the `plan` role with zero tools.
7. Main agent uses the `edit` role.
8. Reviewer/researcher/triage/explorer use distinct roles.
9. Missing role provider key falls back for read-only role when configured.
10. Edit role provider error does not silently duplicate a mutating turn under fallback.
11. `/models explain` redacts secrets and is bounded.
12. Route telemetry records role/provider/model without leaking keys.

## Rollout

### 10F.1 — Pure Router

- Add route types, config parsing, default resolution, fallback validation.
- Add `/models explain` using static config only.

### 10F.2 — Provider Pool

- Add provider cache keyed by resolved route.
- Keep existing CLI behavior by resolving `edit` to the current provider/model.

### 10F.3 — Planning and Subagents

- Route `/plan`, `--plan-first`, reviewer, researcher, triage, explorer.
- Add read-only fallback support.

### 10F.4 — Main Edit/Solve/Delegate

- Route main agent edits and delegated workers through `edit`/`delegate`.
- Do not enable mutating fallback by default.

### 10F.5 — Telemetry and Cost

- Feed route records into Phase 10C telemetry/statusline when available.
- Add usage by role/model to `/usage` or `/models`.

## Acceptance Criteria

- With no new config, behavior matches today's model selection.
- Users can configure `plan`, `review`, and `summarize` roles independently.
- Read-only subagents can fallback to `edit` on provider setup failure.
- Mutating edit turns do not fallback silently after tool calls.
- `/models explain` shows the effective routing table.
- Route telemetry is redacted.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should role-specific provider overrides be allowed from workspace config before a trust gate exists for data-egress changes?
- Should delegated workers inherit parent routing or force a dedicated `delegate` route via env?
- Should summarization use a model in Phase 10F or wait for a model-based compaction phase?
- Should pricing/cost influence routing automatically later, or remain explicit policy only?
