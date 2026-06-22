# Phase 10M — `/goal` Persistent Session Objective

## Context

Deepcoder is now used for long-running work: delegated workers, multi-phase implementation plans, local-bench iterations, SWE-bench experiments, and UI/plugin/provider feature slices. In these sessions the active objective is often spread across conversation history, plan files, and delegated worker prompts. When context compacts or the user pivots, the agent can lose the current "north star".

The next highest-ROI missing slash command is `/goal`: a session-persisted objective that the user can set, inspect, pause, resume, and clear. It gives the agent and the UI a stable, explicit task target without turning every prompt into a new plan.

## Goal

Add a `/goal` command that manages a persistent objective attached to the current session:

```text
/goal
/goal set <objective>
/goal update <objective>
/goal pause [reason]
/goal resume
/goal clear
/goal done [note]
```

The goal should:

- persist in `.deepcoder/sessions/<id>.json`
- be visible in `/status` or statusline later
- be injected into future model context as compact system context
- survive compaction and resume
- never execute tools or call a model

## Non-Goals

- No global project goals in v1.
- No multi-goal task tracker.
- No automatic goal completion detection.
- No remote sync.
- No auto-delegation from a goal.
- No branch/worktree creation.
- No model call to rewrite or summarize the goal.

## UX

Show:

```text
/goal

Goal: implement Phase 10M /goal persistent session objective
Status: active
Updated: 2026-06-22T20:18:00.000Z
```

Set:

```text
/goal set implement /doctor then /model slash commands
Goal set.
```

Pause:

```text
/goal pause waiting for PR review
Goal paused: waiting for PR review
```

Resume:

```text
/goal resume
Goal resumed.
```

Done:

```text
/goal done committed and pushed
Goal marked done.
```

Clear:

```text
/goal clear
Goal cleared.
```

If no goal exists:

```text
No active goal. Use /goal set <objective>.
```

## Data Model

New file: `src/session/goal.ts`

```ts
export type SessionGoalStatus = "active" | "paused" | "done";

export interface SessionGoal {
  objective: string;
  status: SessionGoalStatus;
  createdAt: string;
  updatedAt: string;
  note?: string;
}
```

Pure helpers:

```ts
export function normalizeGoalText(input: string, maxChars?: number): string;
export function setGoal(input: string, now?: Date): SessionGoal;
export function updateGoal(goal: SessionGoal | undefined, input: string, now?: Date): SessionGoal;
export function pauseGoal(goal: SessionGoal, note?: string, now?: Date): SessionGoal;
export function resumeGoal(goal: SessionGoal, now?: Date): SessionGoal;
export function completeGoal(goal: SessionGoal, note?: string, now?: Date): SessionGoal;
export function renderGoal(goal: SessionGoal | undefined): string;
export function goalContext(goal: SessionGoal | undefined): string | null;
```

Rules:

- objective is trimmed, single-spaced, and bounded
- empty objective is rejected
- notes are optional and bounded
- invalid persisted status loads as absent or normalized fail-closed
- no Markdown execution or command parsing

## Persistence

Edit: `src/session/sessionStore.ts`

Add optional `goal?: SessionGoal` to:

- `PersistedSession`
- `SessionSnapshot`

Add it to `SessionStore.save`.

Back-compat:

- old sessions load with `goal === undefined`
- corrupt/invalid goal shape should not crash session load if a guard is added

## Runtime Session

Edit: `src/cli/repl.ts`

Add to `Session`:

```ts
goal?: SessionGoal;
```

Snapshot should include `session.goal`.

Resume should load `persisted.goal` if valid.

## Context Injection

The goal should be visible to future model calls, but it should not pollute the normal transcript as a user message every time.

Add a compact system-context helper:

```text
[session-goal]
status: active
objective: implement /doctor and /model slash commands
```

Preferred implementation:

- inject through the existing ephemeral/context path if available
- otherwise add a bounded system message at session start and update it when `/goal` changes

Constraints:

- paused goals may be shown as paused context, or omitted from active task context
- done/cleared goals must not keep steering the agent
- never inject notes longer than the cap

## Slash Command

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "goal":
  await runGoalSlash(session, arg, save);
  return { consumed: true };
```

Parsing:

- no arg: render current goal
- `set <text>`: replace current goal
- `update <text>`: update objective but preserve createdAt
- `pause [reason]`: status `paused`
- `resume`: status `active`
- `done [note]`: status `done`
- `clear`: remove goal

Invalid commands print usage and do not mutate.

Every mutating subcommand calls `save()`.

## Statusline / `/status`

Minimal v1:

- `/goal` is the source of truth
- no statusline change required

Follow-up:

- show `goal: active|paused|done` in the bottom statusline
- include truncated objective in `/status`
- expose goal in TUI header/footer

## Security

- No command execution.
- No model call.
- No file write except the normal session save.
- Goal text is plain data.
- Bounded objective/note prevents session bloat.
- Goal context is explicitly labeled as user-provided session state, not system policy.

## Tests

New file: `test/adversarial/session-goal.test.ts`

Pure helper tests:

1. empty goal is rejected
2. long objective is bounded
3. whitespace is normalized
4. `setGoal` creates active goal with timestamps
5. `updateGoal` preserves `createdAt`
6. pause/resume transitions are deterministic
7. done stores optional bounded note
8. `goalContext` omits cleared/done goal or marks done as non-active
9. `renderGoal` is bounded and stable

Persistence tests:

10. session save writes `goal`
11. old session with no `goal` loads normally
12. resumed session restores active goal

Slash tests:

13. `/goal` with no goal prints usage hint
14. `/goal set ...` persists goal
15. `/goal pause reason` persists paused status
16. `/goal clear` removes persisted goal
17. invalid subcommand does not mutate

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/session-goal.test.ts
```

Manual smoke:

```text
/goal
/goal set finish the /doctor command
/goal
/save
# restart/resume same session
/goal
/goal pause waiting on review
/goal resume
/goal done committed
/goal clear
```

Expected:

- goal survives `/save` and resume
- goal does not appear as a repeated user message
- cleared/done goal stops steering future model calls
- no config files change

## Delegation Suitability

Good medium-sized delegated slice:

- pure helper module
- bounded session-store schema extension
- one slash command case
- no subprocess/provider/web calls

Suggested scope:

```text
Implement Phase 10M `/goal` only.
Touch only:
- src/session/goal.ts
- src/session/sessionStore.ts
- src/cli/repl.ts
- src/cli/slashCommands.ts
- test/adversarial/session-goal.test.ts
Do not add global project goals, model calls, or auto-delegation.
Run npm run test:phase.
```

## Implementation Order

1. Add `src/session/goal.ts` pure model/helpers.
2. Add pure tests.
3. Extend session persistence.
4. Add `Session.goal` and snapshot/resume wiring.
5. Add `/goal` slash command.
6. Add slash/persistence tests.
7. Add minimal goal context injection.
8. Run full gate.
9. Follow up later with statusline/TUI display.
