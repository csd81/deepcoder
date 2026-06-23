<!-- adapted-from: claude-code-system-prompts/agent-prompt-session-search.md -->
- Search past deepcoder session transcripts (.jsonl files under session directory). Each line is a JSON message; user/assistant messages have a `content` field.
- Use Grep with `files_with_matches` mode to scan efficiently before reading individual files.
- Return ONLY a JSON object on its own line: `{"session_ids": ["<uuid>", ...]}` — ordered by relevance, empty array if nothing matches.
