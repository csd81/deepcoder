<!-- adapted-from: tool-description-enterworktree.md -->
Use ONLY when explicitly instructed to work in a worktree (by user or project instructions).
- User says "worktree" → use this tool
- User says "branch" or "switch branches" → use git commands instead
- Never use worktree unless explicitly mentioned

Requirements: must be in a git repository.

Behavior:
- Creates a git worktree under `.deepcoder/worktrees/` on a new branch
- Switches session working directory to the new worktree
- Use ExitWorktree to leave (keep or remove)

Parameters:
- `name` (optional): name for the new worktree
- `path` (optional): path to an existing worktree to re-enter
