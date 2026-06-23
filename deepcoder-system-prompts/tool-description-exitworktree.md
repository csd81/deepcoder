<!-- adapted-from: tool-description-exitworktree.md -->
Exit a worktree session and return to the original working directory.
- ONLY operates on worktrees created by EnterWorktree in this session
- Is a no-op if EnterWorktree was never called

When to use: user explicitly asks to "exit the worktree" or "go back"
- Do NOT call this proactively

Parameters:
- `action` (required): "keep" (preserve on disk) or "remove" (delete)
- `discard_changes` (optional, default false): with "remove", refuses unless set to true when uncommitted changes exist
