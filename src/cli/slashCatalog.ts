/**
 * Phase 10A7 — pure slash command catalog (metadata only).
 *
 * This module is the navigation/metadata layer for the slash menu. It does NOT
 * execute anything — `handleSlashCommand` (src/cli/slashCommands.ts) remains the
 * sole executor. Entries here mirror the REAL commands found in that switch.
 *
 * No I/O, no terminal access, no runtime file reads. The catalog is a static
 * literal so it is trivially testable and deterministic.
 */

export interface SlashCommandInfo {
  name: string;
  args?: string;
  description: string;
  category: "session" | "context" | "checks" | "delegate" | "web" | "config" | "debug";
  aliases?: string[];
}

/**
 * One entry per real command handled by `handleSlashCommand`. `exit` carries
 * `quit` as an alias (they share a switch case). Categories group commands for
 * the dropdown; they are descriptive, not behavioral.
 */
export const SLASH_CATALOG: SlashCommandInfo[] = [
  // session
  { name: "help", description: "Show command help", category: "session" },
  { name: "exit", description: "Quit the session", category: "session", aliases: ["quit"] },
  { name: "clear", description: "Clear conversation + todos (keep system prompt)", category: "session" },
  { name: "save", description: "Save the session now", category: "session" },
  { name: "fork", description: "Fork the current session to a new id", category: "session" },
  { name: "undo", description: "Undo the last turn's file edits (auto-checkpoint)", category: "session" },
  { name: "redo", description: "Redo the last undone turn", category: "session" },
  { name: "export", args: "[--sanitize] [--stdout]", description: "Export the session to a JSON file", category: "session" },
  { name: "import", args: "<path>", description: "Import a session from a JSON file", category: "session" },
  { name: "title", args: "[name]", description: "Show or set a human-readable session title", category: "session" },
  { name: "clear-title", description: "Remove the session title", category: "session" },
  { name: "status", description: "Show git status", category: "session" },
  { name: "diff", description: "Show git diff", category: "session" },
  { name: "copy", args: "[last|code|diff|goal|plan|check <id>|worker <plan> <worker> [patch|log|review]]", description: "Copy useful session output to clipboard", category: "session" },
  { name: "todos", description: "Show the current todo list", category: "session" },
  { name: "checkpoint", args: "[label]", description: "Snapshot agent edits as an undo point", category: "session" },
  { name: "checkpoints", description: "List checkpoints", category: "session" },
  { name: "rollback", args: "<id> [--force]", description: "Undo agent edits to a checkpoint", category: "session" },

  // context
  { name: "init", description: "Bootstrap .deepcoder/instructions.md from project analysis", category: "context" },
  { name: "understand", description: "Summarize the repository", category: "context" },
  { name: "semantic", description: "Build the semantic index", category: "context" },
  { name: "context", description: "Show context-token usage", category: "context" },
  { name: "compact", description: "Compact conversation history now", category: "context" },
  { name: "instructions", args: "[show|sources|conflicts|reload]", description: "Show project instructions", category: "context" },
  { name: "plan", args: "<task>", description: "Produce a plan with the reasoner model (no tools run)", category: "context" },
  { name: "context-plan", args: "<task>", description: "Build a deterministic context plan from the repo index", category: "context" },
  { name: "explore", args: "<question>", description: "Run a read-only explorer subagent and produce a cited brief", category: "context" },
  { name: "memory", args: "[show|remember|forget|inbox|accept|reject]", description: "View or edit project memory", category: "context" },
  { name: "index", args: "[status|rebuild|symbols|references|impact|tests|explain|search]", description: "Inspect the repo index", category: "context" },

  // checks
  { name: "checks", description: "List configured verification checks", category: "checks" },
  { name: "check", args: "<name>", description: "Run a configured check (gated, bounded, quarantined)", category: "checks" },
  { name: "solve", args: "<check> <task>", description: "Edit, run check, retry until it passes or budget runs out", category: "checks" },
  { name: "triage", args: "<failure|--file <log>|--run <id>|--scope <scope>>", description: "Diagnose a failure (read-only)", category: "checks" },
  { name: "tests", args: "[target|plan|run-targeted]", description: "Automatic minimal test targeting", category: "checks" },

  // delegate
  { name: "delegate", args: "[plan|run|status|review|review-ui|apply|discard]", description: "Plan and run delegated workers", category: "delegate" },
  { name: "review", args: "<scope>", description: "Run a read-only reviewer subagent over files/topic", category: "delegate" },
  { name: "research", args: "<question>", description: "Run a read-only researcher subagent to explain the codebase", category: "delegate" },

  // web
  { name: "web", description: "Show web access status and trace", category: "web" },

  // config
  { name: "mode", args: "[ask|auto|readonly|yolo]", description: "Show or set approval mode", category: "config" },
  { name: "sandbox", args: "[off|fast|local|bubblewrap | network on|off]", description: "Show or set sandbox status", category: "config" },
  { name: "hooks", args: "[enable|disable]", description: "Show or toggle lifecycle hooks", category: "config" },
  { name: "skills", args: "[activate <name>|reload]", description: "List discovered skills", category: "config" },
  { name: "plugins", description: "List discovered plugins", category: "config" },
  { name: "isolation", args: "[status|diff|apply|discard|path]", description: "Manage workspace isolation", category: "config" },
  { name: "mcp", args: "[reload]", description: "List configured MCP servers and tools", category: "config" },
  { name: "models", description: "Show the model routing table", category: "config" },
  { name: "theme", args: "[default|high-contrast|monochrome|muted]", description: "Switch the TUI color theme", category: "config" },
  { name: "model", args: "[<role> [<provider>/<model>]] | reset <role|all>", description: "Inspect or set a session-local model override", category: "config" },
  { name: "effort", args: "[[<role>] <low|medium|high>] | reset <role|all>", description: "Inspect or set reasoning effort", category: "config" },

  // config
  { name: "statusline", args: "[list]", description: "Show or configure statusline fields", category: "config" },

  // debug
  { name: "usage", description: "Show session token usage", category: "debug" },
  { name: "cost", description: "Show estimated session cost", category: "debug" },
  { name: "telemetry", description: "Show session telemetry", category: "debug" },
  { name: "debug-config", args: "[--json]", description: "Show the effective config (redacted) + provenance", category: "debug" },
  { name: "permissions", args: "[--json]", description: "Show the effective permission & sandbox policy", category: "debug" },
  { name: "doctor", args: "[--json] [--section <name>]", description: "Run a read-only runtime health check", category: "debug" },
  { name: "ps", description: "List active background activities", category: "debug" },
  { name: "stop", args: "[<id>|all]", description: "Cancel an active background activity", category: "debug" },

  // session
  { name: "goal", args: "[set|update|pause|resume|clear|done] [text]", description: "Manage the persistent session objective", category: "session" },
  { name: "plan-mode", description: "Toggle interactive plan mode (read-only investigate → approve → execute)", category: "session" },
];

/**
 * Filter the catalog by the token typed after `/` (the leading slash is NOT part
 * of `token`). Case-insensitive prefix match against the command name and any
 * aliases. An empty token returns the whole catalog. Order is stable (matches
 * appear in `catalog` order).
 */
export function filterSlashCommands(catalog: SlashCommandInfo[], token: string): SlashCommandInfo[] {
  const needle = token.toLowerCase();
  if (needle === "") return catalog.slice();
  return catalog.filter((cmd) => {
    if (cmd.name.toLowerCase().startsWith(needle)) return true;
    return (cmd.aliases ?? []).some((a) => a.toLowerCase().startsWith(needle));
  });
}
