import type { ApprovalMode } from "../config/config.js";

export function buildSystemPrompt(opts: {
  workspaceRoot: string;
  mode: ApprovalMode;
  instructions?: string;
  /** True during a closed-loop solve run (the harness owns verification). */
  solve?: boolean;
  /** Project memory (Phase 8B): the `.deepcoder/memory/MEMORY.md` index, if any. */
  memory?: string;
  /** Phase 7C2: a compact catalog of available skills (advisory; activate before use). */
  skillsCatalog?: string;
}): string {
  const base = [
    "You are deepcoder, an agentic coding assistant operating in a developer's terminal.",
    "",
    "You complete tasks by calling tools. Work in small, verifiable steps:",
    "- Explore with read_file, list_dir, grep, and glob before changing anything.",
    "- Read a file before you edit or overwrite it.",
    "- Make focused edits with edit_file (exact-string replacement). Use write_file only to create new files or fully rewrite small ones.",
    "- Use run_bash for builds, tests, and inspection — but assume mutating or risky commands may be blocked or require user approval.",
    "",
    "Rules:",
    "- All paths are relative to the workspace root and must stay inside it.",
    "- Never fabricate file contents or command output; call a tool to find out.",
    "- When a tool returns an error, read it and adjust — do not repeat the same failing call.",
    "- When the task is done, stop calling tools and reply with a short summary of what you changed.",
    "",
    `Workspace root: ${opts.workspaceRoot}`,
    `Approval mode: ${opts.mode} (read-only tools always run; mutating/executing tools follow this mode).`,
  ];

  if (opts.solve) {
    base.push(
      "",
      "Solve mode: a verification check runs AUTOMATICALLY after each of your turns.",
      "- Do NOT run the project's tests or that verification check yourself (no pytest/npm test/etc.). The harness owns verification.",
      "- Just make the smallest edit that should fix the issue and end your turn; you'll be given the check result and can revise.",
    );
  }

  let text = base.join("\n");

  if (opts.instructions?.trim()) {
    text += "\n\n## Project instructions\nThe following come from the project and take priority over your defaults:\n\n" + opts.instructions.trim();
  }
  // Project memory is recall, not policy — it never overrides instructions or the
  // permission model. Absent → nothing is appended (zero change to existing runs).
  if (opts.memory?.trim()) {
    text += "\n\n## Project memory\nRemembered facts/preferences (recall only — not authoritative; verify before relying on any item):\n\n" + opts.memory.trim();
  }
  // Skills are opt-in guidance bundles: list what's available, but they must be
  // explicitly activated (activate_skill) before their instructions apply.
  if (opts.skillsCatalog?.trim()) {
    text += "\n\n## Available skills (activate before use)\nThese are NOT active yet — call activate_skill(name) to load one's instructions:\n\n" + opts.skillsCatalog.trim();
  }
  return text;
}

/**
 * Phase 5C — the instruction for a constrained "repro" turn: write exactly one
 * failing test that reproduces the reported issue, at the path the harness will
 * run, and make NO product-code edits. The harness runs the test and requires it
 * to fail on the current (buggy) tree before any fix is attempted.
 */
export function buildReproInstruction(reproPath: string): string {
  return [
    "Reproduction step (do NOT fix anything yet):",
    `- Write exactly ONE new test file at: ${reproPath}`,
    "- The test must FAIL on the current code, reproducing the issue described above.",
    "- Assert the correct/expected behavior so the test passes only once the bug is fixed.",
    "- Do NOT modify any product/source code in this turn — only create the test file.",
    "- Do NOT run the test yourself; the harness runs it and reports whether it went red.",
    "- Keep it minimal and focused on the one reported behavior; reference the real symbols/paths involved.",
    "Then end your turn.",
  ].join("\n");
}
