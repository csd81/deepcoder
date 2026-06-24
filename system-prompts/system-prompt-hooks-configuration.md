<!-- adapted-from: system-prompt-hooks-configuration.md -->
Hooks run commands at lifecycle points.

**Events:** PermissionRequest, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop, PreCompact, PostCompact, UserPromptSubmit, SessionStart

**Hook types:** command (shell), prompt (LLM condition), agent (full agent with tools). Prompt/agent only for tool events.

**Matchers:** Use tool names (Bash, Write, Edit, Read, Glob, Grep) or "OtherTool" alias.

**stdin JSON:** session_id, tool_name, tool_input, tool_response (PostToolUse only)

**Output fields:** systemMessage, continue/stopReason, suppressOutput, decision/reason, hookSpecificOutput (additionalContext, permissionDecision, updatedInput)

Patterns: auto-format on Write/Edit, log Bash commands, run tests after code changes.
