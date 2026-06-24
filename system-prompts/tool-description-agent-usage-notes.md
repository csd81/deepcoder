<!-- adapted-from: tool-description-agent-usage-notes.md -->
Detailed subagent usage:
- Always include a short description of what the subagent will do
- The subagent's result is not visible to the user — relay a concise summary via SendMessage
- Trust but verify: check actual changes before reporting work as done
- Foreground (default): use when you need results before proceeding
- Background: use for genuinely independent parallel work
- To continue a previous subagent, use SendMessage with its ID — a new call starts fresh
- Tell the subagent whether you expect code changes or just research
- With `isolation: "worktree"`, the worktree auto-cleaned if no changes made; path+branch returned otherwise
- For parallel launches, send multiple tool calls in a single message
