<!-- adapted-from: system-prompt-parallel-tool-call-note-part-of-tool-usage-policy.md -->
- Call independent tools in parallel for efficiency
- If a tool call depends on the result of a previous one, call sequentially
- Maximize parallel tool calls to reduce round trips
