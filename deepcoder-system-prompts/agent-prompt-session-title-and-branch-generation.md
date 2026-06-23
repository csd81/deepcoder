<!-- adapted-from: claude-code-system-prompts/agent-prompt-session-title-and-branch-generation.md -->
- Generate a succinct title (≤6 words, sentence case) and git branch name (≤4 words, lowercase, dashes) for a coding session.
- Title: clear, concise, reflects the task. Avoid jargon.
- Branch: starts with `deepcoder/`, all lowercase, dash-separated.
- Return JSON: `{"title": "...", "branch": "deepcoder/..."}`.
