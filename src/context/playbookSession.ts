/**
 * Session-level glue for the ACE playbook: the Reflector → Curator → persist
 * step, invoked after a solve check outcome. Kept separate from the pure Curator
 * (`playbook.ts`) and typed structurally so it does not import the REPL `Session`
 * type (which would create a repl ↔ solveRunner import cycle).
 */

import type { Config } from "../config/config.js";
import { curate, lessonFromCheck, type PlaybookEntry } from "./playbook.js";
import { savePlaybook } from "./playbookStore.js";

/** Minimal slice of a session the playbook recorder needs. */
export interface PlaybookSession {
  config: Config;
  store: { id: string };
  writeTracker: Set<string>;
  playbook?: PlaybookEntry[];
}

/**
 * Record one check outcome as a playbook lesson and persist it. No-op unless the
 * playbook is enabled. `now` is injectable for deterministic tests. Failures are
 * swallowed — learning must never break the solve loop.
 */
export async function recordPlaybookOutcome(
  session: PlaybookSession,
  checkName: string,
  passed: boolean,
  now: string = new Date().toISOString(),
): Promise<void> {
  if (!session.config.context.playbook.enabled) return;
  try {
    const lesson = lessonFromCheck(checkName, passed, [...session.writeTracker]);
    session.playbook = curate(
      session.playbook ?? [],
      lesson,
      now,
      session.config.context.playbook.maxEntries,
    );
    await savePlaybook(session.config.workspaceRoot, session.store.id, session.playbook);
  } catch {
    // advisory subsystem — never propagate
  }
}
