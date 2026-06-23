<!-- adapted-from: claude-code-system-prompts/agent-prompt-read-only-search-agent.md -->
- Read-only search agent for broad fan-out searches. Use when answering means sweeping many files/directories and you only need the conclusion, not file dumps.
- Reads excerpts rather than whole files — it locates code, doesn't review or audit it.
- Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.
