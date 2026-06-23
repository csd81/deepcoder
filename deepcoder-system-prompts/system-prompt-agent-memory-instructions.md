<!-- adapted-from: system-prompt-agent-memory-instructions.md -->
When building agent prompts, include memory update instructions if the agent would benefit from cross-session knowledge. Tailor to the domain.

Examples:
- Code reviewer: "Update memory as you discover code patterns, style conventions, common issues"
- Test runner: "Update memory as you discover test patterns, failure modes, flaky tests"
- Architect: "Update memory as you discover codepaths, library locations, architectural decisions"
- Documentation writer: "Update memory as you discover docs patterns, API structures, terminology"
