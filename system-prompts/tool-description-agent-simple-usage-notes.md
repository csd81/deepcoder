<!-- adapted-from: tool-description-agent-simple-usage-notes.md -->
Use subagents when the task matches an available agent type, or for independent parallel work.
- A subagent's final message is returned as a tool result — relay what matters to the user
- Use SendMessage with the agent's ID to continue a previously spawned agent with its context
- New call starts fresh (except "fork" which inherits context)
- `isolation: "worktree"` gives the agent its own git worktree
- If you delegate research, do not also run it yourself — wait for the result
