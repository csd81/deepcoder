import { classifyCommand } from "../permissions/commandClassifier.js";
import type { ToolInvocation } from "../tools/types.js";

/**
 * True when an invocation's effect is a WRITE to the workspace — the trigger for
 * copy-on-write isolation (see buildEnsureWritableRoot in sessionFactory.ts):
 *
 *  - kind === "mutate" (edit_file / write_file / delete_file / rename_file /
 *    apply_patch) is always a write.
 *  - kind === "execute" (run_bash) is a write UNLESS the command classifier
 *    proves it read-only ("allow"). "ask"/"deny" commands are treated as
 *    potential writes; a missing command string is conservatively a write. The
 *    classifier itself fails closed to "ask" on parse errors, so an unparseable
 *    command correctly counts as a write here.
 *  - read-only / session tools are never writes.
 */
export function isWriteEffect(inv: ToolInvocation): boolean {
  if (inv.kind === "mutate") return true;
  if (inv.kind === "execute") {
    if (!inv.command) return true; // fail-closed: unknown command → treat as a write
    return classifyCommand(inv.command) !== "allow";
  }
  return false;
}
