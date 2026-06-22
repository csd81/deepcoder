/**
 * Side conversation state for ephemeral in-session forks.
 *
 * Side conversations are lightweight, in-memory forks that let the user ask a
 * quick question (/side <q> or /btw <q>) without losing the main thread's
 * context. The side thread shares the session's model, context, and read tracker
 * — it's instant. Mutations made during a side conversation are flagged on
 * return but NOT auto-discarded.
 *
 * PURE in-memory state — no I/O, no session persistence.
 */

import type { AgentMessage } from "../providers/types.js";

export interface SideState {
  /** Whether we're currently in a side conversation. */
  active: boolean;
  /** Snapshot of the main thread's messages at the fork point. */
  mainMessages: AgentMessage[];
  /** Snapshot of the main thread's read tracker. */
  mainReadTracker: Set<string>;
  /** Snapshot of the main thread's write tracker. */
  mainWriteTracker: Set<string>;
  /** The side thread's messages (starts as a copy of main, grows with side turns). */
  sideMessages: AgentMessage[];
}

/**
 * Fork a side conversation from the current session state.
 *
 * Deep-copies the main thread's messages and trackers so mutations on the side
 * never leak back to the main thread.
 *
 * @param state  Existing side state (if any, replaced by the new fork).
 * @param mainMessages  The main thread's current message list.
 * @param readTracker   The main thread's current read tracker.
 * @param writeTracker  The main thread's current write tracker.
 * @returns A fresh SideState with the main thread snapshotted and side
 *          messages initialized as a deep copy of `mainMessages`.
 */
export function forkSide(
  _state: SideState | null,
  mainMessages: AgentMessage[],
  readTracker: Set<string>,
  writeTracker: Set<string>,
): SideState {
  return {
    active: true,
    mainMessages: structuredClone(mainMessages),
    mainReadTracker: new Set(readTracker),
    mainWriteTracker: new Set(writeTracker),
    sideMessages: structuredClone(mainMessages),
  };
}

/**
 * Return from a side conversation to the main thread.
 *
 * Restores the original messages, read tracker, and write tracker from the
 * fork point. The side thread's messages and any mutations are discarded.
 *
 * @returns An object with the restored `messages`, `readTracker`, and
 *          `writeTracker` that should replace the session's state.
 */
export function returnToMain(state: SideState): {
  messages: AgentMessage[];
  readTracker: Set<string>;
  writeTracker: Set<string>;
} {
  return {
    messages: state.mainMessages,
    readTracker: state.mainReadTracker,
    writeTracker: state.mainWriteTracker,
  };
}
