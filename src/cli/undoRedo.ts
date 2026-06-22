/**
 * Per-turn undo/redo stack — pure, immutable, no I/O.
 *
 * Undo entries carry the pre-image sha for every file the agent changed in a
 * single turn. The stack is bounded by `maxDepth` (default 20) with FIFO
 * eviction. A new mutation clears the redo stack via `onNewMutation`.
 */

export interface UndoEntry {
  /** Human-readable label: first ~60 chars of the user prompt that caused this turn. */
  label: string;
  /** Files changed in this turn: pre-image sha + path for restore. */
  files: Array<{
    path: string; // workspace-relative
    existed: boolean;
    restoreSha: string | null; // null iff !existed (agent created file → delete on undo)
  }>;
}

export interface UndoRedoState {
  undoStack: UndoEntry[]; // most recent at end
  redoStack: UndoEntry[];
  maxDepth: number; // default 20
}

/** Create a fresh undo/redo state with the given maxDepth (default 20). */
export function initState(maxDepth: number = 20): UndoRedoState {
  return { undoStack: [], redoStack: [], maxDepth };
}

/**
 * Push a new turn entry onto the undo stack.
 * If the stack is at maxDepth, the oldest entry is evicted (FIFO).
 * The caller should call `onNewMutation` BEFORE `pushTurn` when a new
 * agent turn (that may mutate) begins, to clear the redo stack.
 */
export function pushTurn(s: UndoRedoState, entry: UndoEntry): UndoRedoState {
  const undoStack = [...s.undoStack, entry];
  // FIFO eviction: if we exceed maxDepth, drop the oldest (front)
  if (undoStack.length > s.maxDepth) {
    undoStack.splice(0, undoStack.length - s.maxDepth);
  }
  return { ...s, undoStack, redoStack: s.redoStack };
}

/**
 * Undo the most recent turn.
 * Returns { state, entry } where entry is null when the undo stack is empty.
 * On undo, the entry moves from undoStack to redoStack.
 */
export function undo(s: UndoRedoState): { state: UndoRedoState; entry: UndoEntry | null } {
  if (s.undoStack.length === 0) {
    return { state: s, entry: null };
  }
  const entry = s.undoStack[s.undoStack.length - 1]!;
  const undoStack = s.undoStack.slice(0, -1);
  const redoStack = [...s.redoStack, entry];
  return { state: { ...s, undoStack, redoStack }, entry };
}

/**
 * Redo the most recently undone turn.
 * Returns { state, entry } where entry is null when the redo stack is empty.
 * On redo, the entry moves from redoStack to undoStack.
 */
export function redo(s: UndoRedoState): { state: UndoRedoState; entry: UndoEntry | null } {
  if (s.redoStack.length === 0) {
    return { state: s, entry: null };
  }
  const entry = s.redoStack[s.redoStack.length - 1]!;
  const redoStack = s.redoStack.slice(0, -1);
  const undoStack = [...s.undoStack, entry];
  return { state: { ...s, undoStack, redoStack }, entry };
}

/**
 * A new mutation occurred — clear the redo stack.
 * Undo stack is unchanged. Returns a new state reference.
 */
export function onNewMutation(s: UndoRedoState): UndoRedoState {
  return { ...s, redoStack: [] };
}
