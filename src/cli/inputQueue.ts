/**
 * PURE, immutable FIFO input queue for type-ahead.
 *
 * When the agent is busy, submitted lines are enqueued rather than dropped,
 * then drained automatically when the current turn finishes.
 *
 * All functions return new objects — the input queue is never mutated.
 */

export interface InputQueue {
  items: string[];
}

/** Create an empty queue. */
export function createInputQueue(): InputQueue {
  return { items: [] };
}

/**
 * Enqueue a line (ignoring empty / whitespace-only strings).
 * Returns a NEW queue; the original is unchanged.
 */
export function enqueue(q: InputQueue, line: string): InputQueue {
  const trimmed = line.trim();
  if (trimmed.length === 0) return q;
  return { items: [...q.items, trimmed] };
}

/**
 * Dequeue the first line (FIFO).
 * Returns `{ queue, line }` where `line` is the string or `null` when empty.
 * Both the returned queue and the original are distinct objects.
 */
export function dequeue(q: InputQueue): { queue: InputQueue; line: string | null } {
  if (q.items.length === 0) {
    return { queue: { items: [] }, line: null };
  }
  const [line, ...rest] = q.items;
  return { queue: { items: rest }, line };
}

/** Return the number of queued items. */
export function queueDepth(q: InputQueue): number {
  return q.items.length;
}

/**
 * Decide what a submit should do given the current busy state.
 * "enqueue" when busy, "run" when idle.
 */
export function decideSubmit(busy: boolean): "run" | "enqueue" {
  return busy ? "enqueue" : "run";
}
