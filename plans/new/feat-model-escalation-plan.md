# Feature — Automatic model escalation (Flash → Pro)

> **Revised after codebase review.** The original draft (a) had a real bug in
> `classifyComplexity` — `a ? 1 : 0 + b` parses as `a ? 1 : (0 + b)`, so the
> score never reaches 2 and it ALWAYS returns `"flash"` (its own test would
> fail); (b) reinvented model selection in a new `src/models/escalation.ts`
> when a full `ModelRouter` already exists; and (c) leaned on a noisy
> "vague-response" heuristic. This revision reuses the existing routing stack,
> drops the bug, and replaces per-turn flapping with sticky escalation.

## Context

Deepcoder defaults to DeepSeek V4 Flash — fast, cheap, fine for ~90% of tasks.
Pro (`deepseek-v4-pro`) is stronger on complex refactors, cross-file changes, and
security review but slower/costlier. Today the user switches manually with
`/model edit deepseek-v4-pro`. Goal: start on Flash, detect when a task needs
Pro, and escalate automatically — without the user thinking about it.

## Reuse what already exists (do NOT reinvent)

- **`ModelRouter`** (`src/models/router.ts`): `resolve(role)` → `{model, provider,
  baseUrl, …}`. Roles incl. `"edit"` (defaults to `config.model` = Flash) and
  `"plan"` (defaults to `config.reasonerModel` = **Pro**) — so "escalate to Pro"
  is literally *resolve a stronger role*, not a new model string. Precedence:
  **session override > env > file > default** (`router.ts:65-86`).
- **Session overrides** (`src/models/sessionOverrides.ts`): `/model edit …` sets
  `modelRouter.sessionOverrides.roles.edit` — the highest-precedence layer. This
  IS the manual lock; escalation must DEFER to it.
- **`ProviderPool.providerFor(route)`** — already used by `runTask` (`repl.ts:425-432`)
  to swap provider/model per resolved route.
- **`src/models/taskRouter.ts`** complexity classifier:
  `classifyComplexity(input) → { complexity, risk, reason }` (complexity ∈
  `simple|normal|hard`), keyword-based (`refactor`, `security`, `architecture`,
  `migration`, `multi-file`, `permission`, …) + multi-file/mutating rules. Use
  this — do NOT write a new (buggy) one. (Note: it takes a task/input object,
  not a bare string — pass the prompt in the shape it expects.)
- **`retry.ts`** (`isRateLimit`/`isAuthError`/`isModelError`) for error signals.

## Model (escalation policy)

Each task starts on the resolved `"edit"` route (Flash by default). Escalate to
the `"plan"`/reasoner route (Pro) on these signals, and once escalated **stay on
Pro for the rest of the task** (sticky — no per-turn flapping):

| Signal | When | Source |
|---|---|---|
| **high-complexity** | at task start, `classifyComplexity(prompt)` is `hard` | `taskRouter.ts` (reuse) |
| **repeated-error** | the SAME tool produces the SAME error signature twice in a row | agent loop, reuse the existing `lastInvalidSignature` machinery in `agentLoop.ts` |
| **explicit** | the turn came from `/plan` (already routes to the reasoner) | existing |

Dropped from the draft:
- **vague-response** — too noisy (`response.text.length < 50` + an undefined
  `lastUserMessageImpliedAction`); a short answer is often correct. Omit.
- **per-turn fallback to Flash** — replaced by stickiness. Flapping re-pays the
  detection cost every turn and produces noisy "escalated/returned" notices.

**Manual lock wins:** if `sessionOverrides.roles.edit` is set (user ran `/model
edit …`), escalation is a no-op — never override an explicit choice.

## Design

### 1. Escalation state (small, on the Session — no new model module)
```ts
// src/models/escalation.ts — STATE + PURE decision only; routing stays in ModelRouter.
export type EscalationReason = "high-complexity" | "repeated-error" | null;
export interface EscalationState { escalated: boolean; reason: EscalationReason; }
export function initEscalation(): EscalationState { return { escalated: false, reason: null }; }
```
Add `escalation?: EscalationState` to `Session`.

### 2. Decision (pure, reuses taskRouter)
```ts
// At task start (in runTask, before the loop):
import { classifyComplexity } from "../models/taskRouter.js";
if (!manualEditOverride(session.modelRouter) &&
    classifyComplexity(taskInputFor(latestUserPrompt)).complexity === "hard") {
  session.escalation = { escalated: true, reason: "high-complexity" };
}
```
`manualEditOverride(router)` = `router.sessionOverrides.roles.edit !== undefined`.

### 3. Per-turn model selection (in the agent loop, via the router)
The loop already resolves the edit route once in `runTask` (`repl.ts:425`). Make
the chosen ROLE depend on escalation, and re-resolve per turn so a mid-task
escalation (repeated-error) takes effect next turn:
```ts
const role = session.escalation?.escalated ? "plan" : "edit";
const route = session.modelRouter.resolve(role);
// model = route.model; provider = pool.providerFor(route)  (existing pattern)
```
Thread the resolved `{model, provider}` into the turn's `getResponse` (the loop
already supports a per-turn `turnDeps` override at `agentLoop.ts` — pass the
escalated model/provider there rather than adding a bespoke `modelOverride`).

### 4. Repeated-error → escalate (reuse existing signature tracking)
`agentLoop.ts` already tracks `lastInvalidSignature` to stop on repeated invalid
calls. Extend that same comparison: on the 2nd identical `{tool}:{error-prefix}`
in a row, set `session.escalation = { escalated: true, reason: "repeated-error" }`
(takes effect next turn). No new error-tracking structure.

### 5. User visibility
One notice when escalation first flips on (not every turn, since it's sticky):
`⚡ Escalated to Pro (high-complexity task)` / `⚡ Escalated to Pro (Flash hit a repeated error)`.
Surface current model in `/model` output (it already prints resolved routes).

## Files
- **New:** `src/models/escalation.ts` (state + pure decision helpers), `test/escalation.test.ts`.
- **Edit:** `src/cli/repl.ts` (`Session.escalation`; set it at task start; pick role per turn via the router), `src/agent/agentLoop.ts` (repeated-error → escalate, reusing `lastInvalidSignature`), `src/cli/slashCommands.ts` (show escalation in `/model`).
- **Reuse (no change):** `ModelRouter` (`src/models/router.ts`), `ProviderPool`, `classifyComplexity` (`src/models/taskRouter.ts`), `retry.ts`.

## Tests
- `classifyComplexity` is reused — assert its existing behavior covers our cases (`"refactor the auth module…"` → `hard`; `"fix typo in main.ts"` → `simple`). (Do NOT re-implement it.)
- Task-start escalation: a `hard` prompt sets `escalation.escalated` → the loop resolves the `"plan"` route.
- Sticky: once escalated, every subsequent turn stays on Pro (no flip back to `"edit"`).
- Repeated identical tool error → escalates on the 2nd occurrence; a different error resets.
- **Manual lock precedence:** `/model edit deepseek-v4-pro` (or any explicit edit override) → escalation is a no-op (does not re-resolve to a different role).
- Default simple task → never escalates (`resolve("edit")` throughout).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: a complex refactor prompt → one `⚡ Escalated to Pro` notice, stays on Pro, completes.
3. Manual: a simple task → stays on Flash, no notice, no extra cost.
4. `/model` shows the active (possibly escalated) edit-route model.

## Safety
- Escalation only changes the resolved model **role** — never touches permission gates, sandbox, or containment.
- Defers to an explicit `/model edit` override (user choice always wins).
- Sticky-per-task (not per-turn) avoids flapping; bounded to one escalation direction (Flash→Pro), so worst case is "the whole task runs on Pro".
- Conservative triggers (reused `hard` classification + a 2nd identical error) — bias toward staying on Flash.

## Out of scope
- No new model-selection engine — all routing flows through the existing `ModelRouter`.
- No de-escalation Pro→Flash mid-task (sticky is simpler and avoids flapping).
- No cost/budget-based escalation (could layer on `budget` later).
