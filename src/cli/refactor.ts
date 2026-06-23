/**
 * `/refactor` — cross-file refactoring as a thin wrapper over the /solve loop.
 *
 * The solver (runSolveCommand) already owns edit→check→retry, preflight context
 * gathering, and the SolveDeps wiring. /refactor adds two things: it parses the
 * same `<check-name> <description>` arg shape as /solve, and it seeds a steering
 * prompt that points the model at the impact tools and an atomic apply_patch.
 * Both are pure so they unit-test without the session/runAgent machinery; the
 * `case "refactor"` handler in slashCommands.ts is the thin wiring layer.
 */

export type RefactorArgs =
  | { ok: true; checkName: string; description: string }
  | { ok: false; usage: string };

const USAGE = "usage: /refactor <check-name> <description>   (gathers impact, edits atomically, verifies the check)";

/**
 * Parse `<check-name> <description>` (mirrors /solve). The first whitespace-
 * delimited token is the check name; the remainder is the description. A missing
 * check name OR description is a usage error.
 */
export function parseRefactorArgs(arg: string): RefactorArgs {
  const [checkName, ...rest] = arg.trim().split(/\s+/);
  const description = rest.join(" ").trim();
  if (!checkName || !description) return { ok: false, usage: USAGE };
  return { ok: true, checkName, description };
}

/**
 * The steering message seeded into history before the solve loop runs. Keeps the
 * model on the refactor workflow: find every site via the index tools, change
 * them in ONE atomic patch, and don't touch anything unrelated. Advisory — the
 * solver cannot force a tool, so this nudges rather than enforces.
 */
export function buildRefactorPrompt(description: string): string {
  return [
    `Refactor task: ${description}`,
    "",
    "Work as a cross-file refactor:",
    "- Use impact_graph and find_references to locate EVERY affected site before editing — do not guess the blast radius.",
    "- Apply all the changes as a SINGLE apply_patch (create/update/delete ops) so the edit is atomic and reviewable.",
    "- Change only what the refactor requires; leave unrelated code untouched.",
    "- The configured check is the success oracle — if it fails you'll get a redacted summary to fix.",
  ].join("\n");
}
