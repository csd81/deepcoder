# Feature — Type-ahead / message queue while the agent is busy

## Context

In Claude Code you can type your next instruction while the agent is working and it
queues, running when the current turn ends. In deepcoder's TUI, submitting while
`busy` currently drops or blocks the input (`src/cli/repl.ts`: `handleSubmit` only
runs a turn when not busy; the composer keys are largely gated on `!busy`). Adding a
small FIFO queue removes a constant flow annoyance. The composer already exists — we
just buffer submits while busy and drain on turn end.

## Model (what type-ahead means)

- Submitting a non-empty line **while the agent is busy** enqueues it (FIFO) and
  echoes it as a "queued" user turn in the transcript, instead of being lost.
- When the current turn finishes (`busy` returns to false), the next queued line is
  dequeued and run automatically — repeating until the queue drains.
- Submitting while **idle** runs immediately (unchanged behavior).
- Slash commands and `!cmd` shell-escapes also queue (they're submitted lines too),
  preserving order relative to plain prompts.

## Design

### 1. Pure module `src/cli/inputQueue.ts` (the testable core)

```ts
export interface InputQueue { items: string[]; }

export function createInputQueue(): InputQueue;          // { items: [] }
export function enqueue(q: InputQueue, line: string): InputQueue;   // append (ignore empty/whitespace)
export function dequeue(q: InputQueue): { queue: InputQueue; line: string | null }; // FIFO take
export function queueDepth(q: InputQueue): number;

/** Decide what a submit should do given busy state. Pure, trivially testable. */
export function decideSubmit(busy: boolean): "run" | "enqueue";
```

`enqueue` ignores empty/whitespace-only lines (no phantom turns). Immutable updates
(return new objects) to match the codebase's reducer style.

### 2. Wiring (`src/cli/repl.ts`)

- Hold `let queue = createInputQueue()` in `runTuiRepl`.
- In `handleSubmit(raw)`: after the `/exit` and empty-line guards, if
  `decideSubmit(busy) === "enqueue"`, `queue = enqueue(queue, line)`, echo a transcript
  notice (`"queued: <line>"` or a distinct queued-user block), `redraw()`, return.
  Otherwise proceed as today.
- Add a `drainQueue()` helper: if `!busy` and `queueDepth(queue) > 0`, `dequeue`,
  then run that line through the SAME submit path (call `handleSubmit(line)` or the
  shared run logic). Call `drainQueue()` at every point `busy` flips back to false —
  i.e. in the `finally` blocks after `runTask(...)` (TUI turn at ~line 1171-1179 and
  the `!cmd` path) — after `busy = false`.
- Guard against re-entrancy: drain one item per completion; the next item's own
  completion drains the following one.
- Show queued depth in the footer/status hint when `queueDepth > 0` (optional sugar).

### 3. Edge cases
- A queued slash command (`/help`, `/clear`) runs through the normal slash dispatch
  when drained — order preserved.
- `/exit` while busy should still exit immediately (handle before the enqueue check),
  matching the current `/exit` early-return.
- Clearing: when the user hits the interrupt (Ctrl+C) on a busy turn, drop the queue
  (don't auto-run queued items after an abort) — `queue = createInputQueue()`.

## Files to change
- **New:** `src/cli/inputQueue.ts`, `test/input-queue.test.ts`.
- **Edit:** `src/cli/repl.ts` (enqueue-on-busy in `handleSubmit`, `drainQueue` after
  each turn, drop-queue on interrupt).

## Tests (pure seams — RED first)
`test/input-queue.test.ts`:
- FIFO: `enqueue(a)`, `enqueue(b)`, two `dequeue`s → `a` then `b`, then `null`.
- `enqueue` ignores empty/whitespace lines (`queueDepth` unchanged).
- `decideSubmit(true) === "enqueue"`, `decideSubmit(false) === "run"`.
- Immutability: `enqueue` returns a new object; the input queue is unchanged.
- `dequeue` on an empty queue → `{ line: null }` and an empty queue.

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with NEW tests.
2. Manual: start a long turn, type two more prompts → they show as queued and run
   in order after the turn finishes; Ctrl+C mid-turn discards the queue.

## Safety
- Pure queue, no I/O, no permission surface. Drained lines run through the exact
  same submit path (so `checkPermission`, mentions, etc. still apply per turn).
- Discard-on-interrupt prevents a Ctrl+C'd run from then firing queued instructions
  the user no longer wants.

## Worker contract notes
- TDD: write the failing `test/input-queue.test.ts` cases first (red on baseline),
  then implement. Green `--check phase` with ZERO new tests is a vacuous pass.
- Keep `inputQueue.ts` pure and immutable; the repl wiring is the only stateful part.
