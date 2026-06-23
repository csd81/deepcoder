import type { ToolResult } from "../tools/types.js";

export interface LearnState {
  active: boolean;
  focus: string;
}

export function initLearnState(): LearnState {
  return { active: false, focus: "all" };
}

const EXPLANATIONS: Record<string, (r: ToolResult) => string | null> = {
  read_file: (r) =>
    r.isError
      ? null
      : "read_file returns line-numbered output with offset/limit support. Files over 1 MB or binary files are rejected. The path is resolved relative to the workspace root and checked against the sensitive-path list.",
  write_file: (r) =>
    r.isError
      ? null
      : "write_file creates or overwrites a file at a workspace-relative path. Parent directories are created automatically. The file must have been read first (read-before-write rule).",
  edit_file: (r) =>
    r.isError
      ? null
      : "edit_file performs exact-string replacement. The old_string must match the file byte-for-byte — copy the exact text. It requires the file to have been read first. If old_string matches multiple times, use replace_all: true or add more context.",
  run_bash: (r) =>
    r.isError
      ? null
      : "run_bash executes from the workspace root. Dangerous commands (rm, sudo, chmod) are classified and may be blocked by the permission policy regardless of approval mode.",
  glob: () =>
    "glob finds files matching a pattern (supports *, **, ?). Returns matching paths relative to the workspace root.",
  grep: () =>
    "grep searches file contents for a regex pattern. Use it before reading to locate the right file. Add a glob filter (e.g., '*.ts') to narrow results.",
  list_dir: () =>
    "list_dir shows the entries of a directory. Directories are marked with a trailing '/'. Useful for exploring the project structure before reading specific files.",
  delete_file: (r) =>
    r.isError ? null : "delete_file removes a file. It is NOT recursive — directories cannot be deleted. Captured by checkpoints so /rollback can restore it.",
  rename_file: (r) =>
    r.isError ? null : "rename_file moves a file within the workspace. The source must exist. The destination parent directory is created automatically.",
  todo_write: () =>
    "todo_write records the task list for the session. Pass the FULL list each time. At most one task may be 'in_progress'. Used to track multi-step work and progress.",
  repo_map: () =>
    "repo_map returns a compact, token-bounded map of TypeScript/JavaScript files and their top-level symbols. Use it to orient on an unfamiliar codebase before reading files.",
  find_symbols: () =>
    "find_symbols searches the repo's indexed top-level symbols by name (case-insensitive). Returns matching file:line locations.",
  list_recent_context: () =>
    "list_recent_context shows what the session already knows: compaction summaries, recently read/edited files, and current todos.",
  apply_patch: () =>
    "apply_patch applies a multi-file change atomically (create, update, delete). All operations are validated before any write begins. On validation failure, nothing is written.",
  delegate: () =>
    "delegate hands a bounded, read-only subtask to a focused subagent. The subagent runs independently and returns a structured summary. Use this for independent sub-tasks that don't depend on each other.",
};

export function generateToolExplanation(toolName: string, result: ToolResult): string | null {
  const fn = EXPLANATIONS[toolName];
  if (!fn) return null;
  return fn(result);
}
