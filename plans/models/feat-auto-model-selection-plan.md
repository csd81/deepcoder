# Feature — Automatic model selection by task complexity (prefer cheaper)

## Context

We've been running `deepseek-v4-pro` for everything (~2× the token price of
`deepseek-v4-flash`). The policy is now: **default to Flash; use Pro only when the task
genuinely needs it.** Make deepcoder DECIDE this **algorithmically** from signals available
*before* running — "don't pay double unless necessary." There is already a reactive
`Flash→Pro` escalation (`src/models/escalation.ts`) and a `ModelRouter` (`src/models/router.ts`);
this adds a *proactive* up-front choice and keeps escalation as the fallback.

## Design

### New: `src/models/complexityScore.ts` (pure, the whole point)
```ts
export interface ComplexitySignals {
  prompt: string;
  fileCount?: number;         // files/areas in scope (e.g. plan/allowedPaths)
  hasCheck?: boolean;         // a configured check/test exists
}
export interface ComplexityVerdict { score: number; model: "flash" | "pro"; reasons: string[]; }

// PURE heuristic — no model call. Higher score → harder → Pro.
export function scoreComplexity(s: ComplexitySignals, opts?: { threshold?: number }): ComplexityVerdict;
```
Heuristic signals (cheap, deterministic):
- **Keywords** → +weight: `security`, `refactor`, `migrate`, `concurren`, `race`,
  `permission`, `classifier`, `architecture`, `cross-cutting`, `deadlock`.
- **Scope breadth** → +weight per file/area beyond 1.
- **Prompt length** → long, multi-step prompts score higher.
- **Default LOW** → Flash unless `score >= threshold` (default tuned so trivial tasks =
  Flash, security/cross-cutting = Pro).
Return `model: "flash"` by default; `"pro"` only above threshold. Always list `reasons`.

### Wire it (minimal, behind a config flag)
- `src/runtime/sessionFactory.ts` / the delegate model-override path: when no explicit
  model is set, call `scoreComplexity` on the task to pick Flash vs Pro.
- The delegate worker model (`scripts` / `delegateCli`): default the worker model from the
  scorer instead of hardcoding `deepseek-pro`.
- Keep the reactive `escalation.ts` Flash→Pro as the safety net (Flash got stuck).
- Config knob `DEEPCODER_MODEL_AUTO=on|off` (default on) + an explicit `DEEPCODER_MODEL`
  always wins (manual override).

## Files to change
- **New:** `src/models/complexityScore.ts`, `test/model-complexity.test.ts`.
- **Edit:** `src/runtime/sessionFactory.ts` (or `models/router.ts`) — use the scorer for the
  default model; `src/config/config.ts` — the `MODEL_AUTO` flag.

## Tests (RED first — the scorer is pure)
- trivial task ("add an isBlank helper") → `flash`.
- security/cross-cutting task ("fix the permission classifier bypass across the agent loop")
  → `pro`, with reasons citing the keywords.
- explicit `DEEPCODER_MODEL` overrides the scorer.
- threshold boundary cases.

## Safety / invariants
- An explicit model choice ALWAYS wins over the scorer.
- The scorer never *blocks* — worst case it picks a sub-optimal model; escalation recovers.
- Pure + deterministic → fully unit-testable, no live model needed.
