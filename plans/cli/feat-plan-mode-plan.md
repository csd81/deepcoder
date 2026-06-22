# Feature — Interactive Plan Mode (investigate → approve → execute)

## Context

`/plan <task>` today is plan-*only*: it asks the reasoner for a plan and prints it,
but never executes. Claude Code's signature "plan mode" is the loop the team trusts
for big changes: the agent investigates **read-only**, proposes a plan, the user
**approves**, and only then does it execute. We already have every piece —
`readonly` approval mode, the `/plan` reasoner call (`src/cli/slashCommands.ts`
case `"plan"`), `checkPermission` (`src/permissions/policy.ts`), and the approval
modal in the TUI. This wires them into one flow.

## Model (what Plan Mode means)

- **Enter** plan mode → the session is forced **read-only**: every mutating/executing
  tool is denied, so investigation can't change anything.
- The agent investigates and **proposes a plan** (free-form text).
- The user is shown an **approve/reject** prompt. On approve, the session flips back
  to its prior approval mode (e.g. `auto`) and the plan is fed as the next
  instruction to execute. On reject, it stays read-only and the plan is discarded.
- Plan mode is a **session toggle**, independent of `/plan` (which stays plan-only).

## Design

### 1. Pure state machine `src/cli/planMode.ts` (the testable core)

```ts
export type PlanPhase = "off" | "investigating" | "awaiting-approval" | "executing";

export interface PlanModeState {
  phase: PlanPhase;
  priorMode: ApprovalMode | null; // mode to restore on approve/exit
  plan: string | null;
}

export function initPlanMode(): PlanModeState;               // { phase:"off", ... }
export function enterPlanMode(s, currentMode): PlanModeState; // -> investigating, priorMode=currentMode
export function recordPlan(s, planText): PlanModeState;       // investigating -> awaiting-approval
export function approvePlan(s): PlanModeState;                // awaiting-approval -> executing
export function rejectPlan(s): PlanModeState;                 // awaiting-approval -> investigating (plan=null)
export function exitPlanMode(s): PlanModeState;               // -> off

/** Effective approval mode while plan mode is active: read-only until executing. */
export function effectivePlanModeApproval(
  s: PlanModeState, baseMode: ApprovalMode,
): ApprovalMode; // investigating|awaiting-approval -> "readonly"; executing|off -> baseMode
```

Invariants the tests pin: illegal transitions are no-ops (e.g. `approvePlan` when
not `awaiting-approval` returns the state unchanged); `priorMode` round-trips; once
`executing`, `effectivePlanModeApproval` returns the base mode (so edits run).

### 2. Permission integration (`src/permissions/policy.ts` — minimal)

No change to `checkPermission` itself. The caller computes the effective mode via
`effectivePlanModeApproval(planState, session.mode)` and passes THAT as `mode`. So
during investigate/awaiting-approval the existing `readonly` branch denies mutate/
execute — investigation is provably side-effect-free with code we already trust.

### 3. Wiring (`src/cli/repl.ts` + a slash command)

- Add `/plan-mode` (and a `planMode` entry in `src/cli/slashCatalog.ts`). Toggling
  on calls `enterPlanMode`, shows a notice ("Plan mode: read-only — investigating;
  I'll propose a plan for approval"), and the agent loop reads the effective mode
  from `effectivePlanModeApproval`.
- When the agent ends a turn while `investigating`, treat its final assistant text
  as the proposed plan: `recordPlan`, then raise the **approval modal** ("Execute
  this plan? [y/N]"). Reuse the existing `approve`/approval-modal seam.
- Approve → `approvePlan` (mode flips to prior), push the plan text as a user turn
  (`"Execute this plan:\n<plan>"`) and run. After the execute turn completes,
  `exitPlanMode`. Reject → `rejectPlan`, stay read-only.

Keep the agent-loop change tiny: the loop already takes a mode; feed it the
effective mode. The state transitions live in the pure module.

## Files to change
- **New:** `src/cli/planMode.ts`, `test/plan-mode.test.ts`.
- **Edit:** `src/cli/repl.ts` (toggle, effective-mode wiring, end-of-turn approval
  → execute), `src/cli/slashCatalog.ts` (`/plan-mode` entry).

## Tests (pure seams — RED first)
`test/plan-mode.test.ts`:
- Transition path: `init → enter(auto) → record("the plan") → approve → executing`,
  asserting phase at each step and `priorMode === "auto"`.
- `effectivePlanModeApproval`: `investigating`/`awaiting-approval` → `"readonly"`;
  `executing` → base mode; `off` → base mode.
- Illegal transition no-ops: `approvePlan` from `investigating` returns input
  unchanged; `recordPlan` from `off` unchanged.
- Reject path: `awaiting-approval → reject → investigating` with `plan === null`.
- **Integration-ish (pure):** `checkPermission(mutateInvocation, effectivePlanModeApproval(investigating, "auto"))` → `"deny"`; after `approve`, with `executing` → `"allow"`/`"ask"` per base mode.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with NEW tests.
2. Manual: `/plan-mode`, ask for a change → agent only reads (a mutate is denied),
   proposes a plan, approve → it edits; reject → stays read-only.

## Safety
- Investigation is read-only via the *existing* `readonly` policy branch — no new
  permission path to get wrong. Execution only after explicit approval.
- The plan text is model-authored: it's pushed as a normal user instruction, not
  used to bypass any gate; all execute-phase tools still pass `checkPermission`.

## Worker contract notes
- TDD: write the failing `test/plan-mode.test.ts` transition + permission cases
  first (red on baseline), then implement. Green `--check phase` with ZERO new
  tests is a vacuous pass and will be rejected.
- Keep `planMode.ts` pure (no I/O); import `ApprovalMode` as a type only.
