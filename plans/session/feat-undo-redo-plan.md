# Feature — Per-turn undo/redo (`/undo`, `/redo`)

## Context

Deepcoder already has checkpoint/rollback, but it's manual (opt-in `/checkpoint` or auto-mode task-boundary snapshots) and requires the user to know a checkpoint id (`/rollback <id>`). In OpenCode and Claude Code, `/undo` reverses the last agent turn automatically — no planning ahead, no IDs. Deepcoder has all the plumbing (`CheckpointRecorder.capture` pre-images, `rollback` restore logic, `resolveRealPathInWorkspace` for safety) but no per-turn undo stack.

## Model (what undo/redo means)

- After each agent turn that mutated files, deepcoder auto-snapshots the set of changed files and their pre-images into an **in-memory undo stack** (keeps last N turns).
- `/undo` pops the most recent entry from the undo stack and restores those files to their pre-turn state. The undo entry moves to a **redo stack**.
- `/redo` pops from the redo stack and reapplies the changes. The entry moves back to the undo stack.
- A new agent turn (any mutation) **clears** the redo stack (redo is only valid after an undo with no intervening mutation).
- On session save/resume, the undo stack can be reconstructed from the *last* checkpoint if needed, but the primary mode is in-memory — no new persistence layer.

## Design

### 1. Pure module `src/cli/undoRedo.ts` (the testable core)

```ts
export interface UndoEntry {
  /** Human-readable label: first ~60 chars of the user prompt that caused this turn. */
  label: string;
  /** Files changed in this turn: pre-image sha + path for restore. */
  files: Array<{
    path: string;           // workspace-relative
    existed: boolean;
    restoreSha: string | null; // null iff !existed (agent created file → delete on undo)
  }>;
}

export interface UndoRedoState {
  undoStack: UndoEntry[];   // most recent at end
  redoStack: UndoEntry[];
  maxDepth: number;         // default 20
}

export function initState(maxDepth?: number): UndoRedoState;
export function pushTurn(s: UndoRedoState, entry: UndoEntry): UndoRedoState;
export function undo(s: UndoRedoState): { state: UndoRedoState; entry: UndoEntry | null };
export function redo(s: UndoRedoState): { state: UndoRedoState; entry: UndoEntry | null };
export function onNewMutation(s: UndoRedoState): UndoRedoState;  // clears redo stack
```

Invariants:
- `undo` on empty undoStack → null entry, state unchanged.
- `redo` on empty redoStack → null entry, state unchanged.
- `pushTurn` after a mutation without intervening undo → first pushes `onNewMutation` (clears redo), then appends.
- `pushTurn` at maxDepth drops the oldest entry (FIFO eviction).

### 2. Collecting turn data (wiring into `CheckpointRecorder`)

Reuse the existing `CheckpointRecorder` hooks. The recorder already captures `capture(realAbs)` (pre-image before write) and `recordPostWrite(realAbs)` (post-write sha). At turn end:

```ts
// on each completed agent turn:
const pending = recorder.serialize();   // returns CheckpointFile[] from the current window
const files = pending
  .filter(e => e.expectedSha !== undefined)  // only actually-written files
  .map(e => ({ path: e.path, existed: e.existed, restoreSha: e.restoreSha ?? null }));
if (files.length > 0) {
  undoState = pushTurn(undoState, { label: truncate(lastUserPrompt, 60), files });
}
```

This does NOT call `recorder.finalize()` — the existing checkpoint system is independent. The recorder's pending window is already populated by the mutating tools; we just snapshot it per turn.

### 3. Wiring (`src/cli/repl.ts` + slash commands)

- Hold `let undoState = initState()` in `runTuiRepl`.
- At the end of each agent turn (after `busy = false`, same hook points as type-ahead queue drain), collect pending files from the recorder and `pushTurn`.
- Add `/undo` and `/redo` to `slashCatalog.ts`.
- In `handleSlashCommand`: `/undo` → `undo(undoState)`, if an entry is returned, restore each file using the same blob-read + write logic from `checkpoints.ts` (or call a shared helper). Emit a notice listing restored/deleted paths. `/redo` → `redo(undoState)`, apply the same way.
- Call `onNewMutation` before `pushTurn` when a new turn starts (clears redo).

### 4. Shared restore helper

Extract a small, testable function `applyUndoEntry(root, entry)` from the existing `rollback()` in `checkpoints.ts`. Reuse the blob store, `resolveRealPathInWorkspace`, and `isSensitivePath` guards verbatim.

```ts
export interface UndoApplyResult { restored: string[]; deleted: string[]; skipped: string[]; }
export function applyUndoEntry(root: string, entry: UndoEntry): Promise<UndoApplyResult>;
```

For `/redo`, re-application needs the content that was *written* during that turn. During `pushTurn`, also record the post-write sha (already available via `CheckpointFile.expectedSha`). The redo apply reads blobs keyed by expectedSha for files that existed at the time (or re-creates files the agent created).

## Files to change

- **New:** `src/cli/undoRedo.ts`, `test/undo-redo.test.ts`.
- **Edit:** `src/cli/repl.ts` (per-turn snapshot, undo/redo wiring), `src/cli/slashCatalog.ts` (`/undo`, `/redo` entries), `src/cli/slashCommands.ts` (handlers).
- **Extract:** `src/session/checkpoints.ts` — pull blob-read + restore into a shared helper (`applyUndoEntry`), keeping `rollback()` as a thin wrapper.

## Tests (pure seams — RED first)

`test/undo-redo.test.ts`:

- `initState()` → `{ undoStack: [], redoStack: [], maxDepth: 20 }`.
- `pushTurn` with one file → undoStack has one entry, redoStack empty.
- `undo` → entry returned, undoStack empty, redoStack has the entry.
- `redo` → entry returned, redoStack empty, undoStack has the entry.
- `undo` on empty → null, state unchanged.
- `redo` on empty → null, state unchanged.
- `onNewMutation` → redoStack cleared, undoStack unchanged.
- `pushTurn` at maxDepth → oldest entry evicted (FIFO).
- `pushTurn` after mutation (no intervening undo) → calls `onNewMutation` first (clears redo).

`test/undo-redo-apply.test.ts` (integration-ish, temp dir):
- `applyUndoEntry` restores a file from blob store.
- `applyUndoEntry` deletes an agent-created file.
- `applyUndoEntry` skips sensitive paths.
- `/redo` re-applies a previously-undone change (create temp file, undo, redo → file is back).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green with new tests.
2. Manual: ask the agent to edit a file, then `/undo` → file reverts. `/redo` → change reapplied. Edit again → redo stack cleared.

## Safety

- Reuses existing blob store, `resolveRealPathInWorkspace`, `isSensitivePath` guards from checkpoints — no new permission surface.
- The undo stack is in-memory only; no secrets written to disk beyond what checkpoints already handle.
- A long undo chain is bounded by `maxDepth` (default 20), so memory is bounded.
- `/redo` is only valid immediately after `/undo` with no intervening mutation — the `onNewMutation` clear rule prevents replaying stale edits.

## Worker contract notes

- TDD: write the failing `test/undo-redo.test.ts` pure state-machine cases first (red on baseline), then implement. Green `--check phase` with ZERO new tests is vacuous.
- Keep `undoRedo.ts` pure; all I/O lives in the caller (slash handlers) and the shared `applyUndoEntry` helper.
- The `applyUndoEntry` helper is the only shared code across undo and redo — keep it in `checkpoints.ts` near the existing `rollback` logic to avoid circular imports.
