/**
 * Phase 10M — Session Goal
 *
 * A persistent session objective the user can set, inspect, pause, resume,
 * and clear.  Pure helpers — no network, no model calls, no file I/O.
 */

export type SessionGoalStatus = "active" | "paused" | "done";

export interface SessionGoal {
  objective: string;
  status: SessionGoalStatus;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on objective length (characters). */
export const MAX_GOAL_CHARS = 2000;

/** Hard cap on note length (characters). */
export const MAX_NOTE_CHARS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise user-supplied goal/note text:
 *  - trim leading/trailing whitespace
 *  - collapse internal whitespace runs to a single space
 *  - clamp to `maxChars` (defaults to MAX_GOAL_CHARS)
 *  - return empty string when the result is only whitespace or empty
 */
export function normalizeGoalText(input: string, maxChars: number = MAX_GOAL_CHARS): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, maxChars);
}

/** Create a new active goal.  Throws if `input` normalises to empty. */
export function setGoal(input: string, now?: Date): SessionGoal {
  const objective = normalizeGoalText(input);
  if (!objective) throw new Error("Goal objective must not be empty");
  const timestamp = (now ?? new Date()).toISOString();
  return {
    objective,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Update an existing goal's objective while preserving `createdAt`.
 * If `goal` is undefined, delegates to `setGoal`.
 * Throws if the new input normalises to empty.
 */
export function updateGoal(goal: SessionGoal | undefined, input: string, now?: Date): SessionGoal {
  const objective = normalizeGoalText(input);
  if (!objective) throw new Error("Goal objective must not be empty");
  if (!goal) {
    return setGoal(input, now);
  }
  const timestamp = (now ?? new Date()).toISOString();
  return {
    ...goal,
    objective,
    updatedAt: timestamp,
    note: undefined, // clear note on explicit objective change
  };
}

/** Pause an active goal.  Already-paused goals are accepted as idempotent. */
export function pauseGoal(goal: SessionGoal, note?: string, now?: Date): SessionGoal {
  const timestamp = (now ?? new Date()).toISOString();
  return {
    ...goal,
    status: "paused",
    updatedAt: timestamp,
    note: note ? normalizeGoalText(note, MAX_NOTE_CHARS) || undefined : undefined,
  };
}

/** Resume a paused goal.  Only paused goals may be resumed. */
export function resumeGoal(goal: SessionGoal, now?: Date): SessionGoal {
  if (goal.status !== "paused") {
    throw new Error("Only a paused goal can be resumed");
  }
  const timestamp = (now ?? new Date()).toISOString();
  return {
    ...goal,
    status: "active",
    updatedAt: timestamp,
    note: undefined,
  };
}

/** Mark a goal as complete (done).  Accepts any status. */
export function completeGoal(goal: SessionGoal, note?: string, now?: Date): SessionGoal {
  const timestamp = (now ?? new Date()).toISOString();
  return {
    ...goal,
    status: "done",
    updatedAt: timestamp,
    note: note ? normalizeGoalText(note, MAX_NOTE_CHARS) || undefined : undefined,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a goal for human display (e.g. `/goal` output).
 * Always produces stable, bounded output — never a model call or Markdown
 * execution.
 */
export function renderGoal(goal: SessionGoal | undefined): string {
  if (!goal) return "No active goal. Use /goal set <objective>.";
  const lines: string[] = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Updated: ${goal.updatedAt}`,
  ];
  if (goal.note) {
    lines.push(`Note: ${goal.note}`);
  }
  return lines.join("\n");
}

/**
 * Compact goal context string for model system-context injection.
 * Returns `null` when the goal should NOT steer the model (cleared, done, or
 * absent).  Returns a labelled block for active/paused goals.
 *
 * Output is bounded, explicitly labelled as user-provided session state, and
 * NEVER injected as a system policy directive.
 */
export function goalContext(goal: SessionGoal | undefined): string | null {
  if (!goal) return null;
  if (goal.status === "done") return null; // done goals stop steering
  const noteLine = goal.note ? `\nnote: ${goal.note}` : "";
  return `[session-goal]\nstatus: ${goal.status}\nobjective: ${goal.objective}${noteLine}`;
}
