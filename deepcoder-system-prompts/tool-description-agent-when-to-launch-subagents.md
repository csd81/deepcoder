<!-- adapted-from: tool-description-agent-when-to-launch-subagents.md -->
Launch subagents for complex, multi-step tasks that match an agent type's capabilities.
- Available agent types appear in system-reminder messages
- "fork" inherits your full conversation context and always runs on your model
- Other types (or omitting subagent_type) start a fresh general-purpose agent
- Use for delegating well-scoped work that benefits from isolation or parallel execution
