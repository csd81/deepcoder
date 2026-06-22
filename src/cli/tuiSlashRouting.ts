/**
 * TUI slash-command routing.
 *
 * In the scrollable TUI, a slash command's output must reach the user. Two paths:
 *
 *  - INLINE (default): capture the command's stdout and render it as a transcript
 *    block, without leaving the alt-screen. Safe for display/read-only commands
 *    that print quickly and synchronously.
 *
 *  - SUSPEND: tear down the TUI (restore the normal screen), run the command, then
 *    re-enter. Required for commands that run for seconds while yielding to the
 *    event loop (model calls), stream live output via `onData`, or read raw stdin
 *    interactively — capturing those would buffer their output until completion and
 *    let the redraw loop's escape sequences leak into the capture buffer.
 *
 * Inverting the historical allowlist into this small SUSPEND denylist means new
 * display commands (e.g. `/understand`) render in the TUI by default instead of
 * silently printing to the hidden normal screen.
 */
const TUI_SUSPEND_SLASH = new Set<string>([
  "plan",         // awaits a (slow) reasoner model call, then prints
  "solve",        // runs the agent loop + streams check output
  "resolve",      // runs an agent turn to resolve merge conflicts (streams + approvals)
  "delegate",     // streams worker output and reads stdin confirmations
  "research",     // read-only subagent: long model call
  "review",       // read-only subagent: long model call
  "explore",      // explorer subagent: long model call (own SIGINT handling)
  "triage",       // triage subagent: long model call
  "context-plan", // loads the repo index and runs a context build
  "tests",        // runs targeted checks, streams output
  "check",        // runs a configured check, streams output via onData
  "index",        // semantic index build: long embedding pass with progress
  "semantic",     // alias surface for the semantic index build
  // Git workflow commands: mutating ones prompt for confirmation via readline,
  // which needs the normal screen (suspend the alt-screen).
  "commit", "branch", "stash", "revert", "reset", "amend",
  "push", "pull", "rebase", "merge", "cherry-pick",
]);

/**
 * True when the given slash command (name without the leading `/`) must SUSPEND
 * the TUI alt-screen instead of rendering inline. Case-insensitive; unknown
 * commands render inline.
 */
export function slashNeedsSuspend(cmd: string): boolean {
  return TUI_SUSPEND_SLASH.has(cmd.toLowerCase());
}
