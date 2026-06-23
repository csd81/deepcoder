<!-- adapted-from: tool-description-agent-explicit-spawn-restriction.md -->
- Do not spawn subagents unless the user explicitly asks
- Each spawn starts cold and re-derives context you already have — it's the expensive path
- A task with "multiple angles", "thorough", or several parts is not a request to spawn; handle it inline
- Only use this tool when the user says to use a subagent or names an agent type
