# Phase 7B — MVP slice: PreToolUse lifecycle hooks

De-ambiguated, minimal first slice of `plans/phase7b-lifecycle-hooks-plan.md`, folding in the
review findings. **Ship PreToolUse only.** Everything else (Post*/Session*/UserPromptSubmit,
context injection, runtime enable/disable, project-trust mechanism) is deferred.

## Decisions (locked — resolve the review's ambiguities)
- **Placement (critical):** a PreToolUse hook fires in `agentLoop.ts` **after** `checkPermission`
  returns `allow`/`ask` **and** after the user approves (the `ask` branch), **before**
  `invocation.execute(ctx)` (line ~140). A policy-`deny` tool returns earlier and **never reaches a
  hook** — so a hook can *add* a deny but can never override a core deny or the headless auto-deny.
- **Decision model:** a hook may **deny** (block the tool) or do nothing. It cannot "allow-override".
  First deny wins, hooks run in **declared array order**.
- **Fail-open:** any hook failure — non-zero exit other than 2, crash/signal, invalid-JSON stdout,
  or timeout — is a no-op (warn + continue), **never** a crash and never an implicit deny.
  Deny requires an explicit signal (see below).
- **Deny signal:** exit code `2`, **or** stdout JSON `{"decision":"deny"}`. Reason = parsed
  `reason` (redacted) or a default.
- **Sandbox:** hook commands run through `wrapCommand` (`src/sandbox/index.js`) with **network forced
  `off`** and a bounded timeout (default 30s, max 300s — reuse the `checks/runner.ts` constants).
  Hook commands are user-configured, so they do **not** go through `classifyCommand`.
- **Redaction:** `redactSecrets` is applied to the surfaced `reason` (and any logged output);
  raw hook stdout/stderr is never returned to the model.
- **Disabled by default:** `hooks.enabled` defaults `false`; no hooks run unless enabled in config.

## API (the seeded tests are the contract)
`src/hooks/types.ts`
```ts
export type HookEvent = "PreToolUse";
export interface HookConfig { name: string; matcher?: string; command: string; timeoutMs?: number; }
export interface HooksConfig { enabled: boolean; events: Partial<Record<HookEvent, HookConfig[]>>; }
export interface PreToolUseInput { tool: string; command?: string; affectedPaths?: string[]; }
export type HookDecision = "deny" | "none";
export interface HookOutcome { decision: HookDecision; reason?: string; }
export const DEFAULT_HOOKS: HooksConfig = { enabled: false, events: {} };
```
`src/hooks/matcher.ts`
```ts
// hooks whose matcher (regex, tested against input.tool OR input.command) match; no matcher → all;
// an invalid regex is skipped (never throws).
export function matchHooks(hooks: HookConfig[], input: PreToolUseInput): HookConfig[];
```
`src/hooks/runner.ts`
```ts
export interface HookRunContext { workspaceRoot: string; sandbox?: SandboxConfig; signal?: AbortSignal; }
// matchHooks internally, run each matched hook in declared order via wrapCommand (network off,
// bounded timeout), parse stdout JSON, redact reason. Return {decision:"deny",reason} on the FIRST
// deny (exit 2 or {"decision":"deny"}), else {decision:"none"}. Never throws.
export function runPreToolUseHooks(hooks: HookConfig[], input: PreToolUseInput, ctx: HookRunContext): Promise<HookOutcome>;
```

## Wiring
- `src/agent/agentLoop.ts`: add `onPreToolUse?(invocation, ctx): Promise<HookOutcome | undefined>` to
  `AgentDeps`; call it after the `ask`/approval block, before `execute`. On `decision === "deny"`:
  `onToolCall` (so it's visible), push a tool result `Blocked by hook: <reason>`, `onPersist`, and
  `continue` (skip execute). Otherwise proceed unchanged. When `onPreToolUse` is undefined, behavior
  is exactly as today.
- `src/cli/repl.ts`: build `onPreToolUse` from `session.config.hooks` (only when `enabled` and a
  PreToolUse list exists) → calls `runPreToolUseHooks(events.PreToolUse, {tool, command, affectedPaths},
  {workspaceRoot: session.executionRoot ?? config.workspaceRoot, sandbox: config.sandbox, signal})`.
- `src/config/fileConfig.ts` + `config.ts`: add a `hooks` block (zod-validated; event names from a
  fixed enum) to `FileConfig` and `Config`, defaulting to `DEFAULT_HOOKS`, merged like `sandbox`.
- `src/cli/slashCommands.ts`: `/hooks` — read-only status (enabled?, per-event hook names + matchers).

## Acceptance (no model)
- `npm run typecheck` clean; `npm run test:phase` green, including the two seeded files:
  - `test/adversarial/hooks-runner.test.ts` — matcher filtering; exit-2 deny (first-deny-wins);
    fail-open on crash/non-2/bad-JSON/timeout; reason redaction; `loadConfig` parses a hooks block.
  - `test/adversarial/hooks-pretooluse.test.ts` — a hook deny blocks `execute` (side effect absent);
    `none` lets it run; a policy-denied tool (readonly) **never consults the hook**.
- `/hooks` prints status.

## Out of scope (defer)
Post*/Session*/UserPromptSubmit events, context injection, `/hooks enable|disable`, the project-trust
mechanism (arbitrary-code-exec gate — design separately before enabling project hooks by default).
