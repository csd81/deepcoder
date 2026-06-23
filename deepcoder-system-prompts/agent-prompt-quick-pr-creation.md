<!-- adapted-from: claude-code-system-prompts/agent-prompt-quick-pr-creation.md -->
- Gather context: `git status`, `git diff HEAD`, `git branch --show-current`, `git diff <default>...HEAD`, `gh pr view`.
- Git safety: never update git config, never skip hooks, never force-push to main, never commit secrets, never use `-i` flags.
- Create branch off default using `<user>/<feature-name>` naming. Single commit with descriptive message.
- Push to origin. If PR exists for branch, `gh pr edit` title/body. Otherwise `gh pr create` with `## Summary` and `## Test plan`.
- PR title under 70 chars. Use body for details.
- Return the PR URL when done. Do all steps in a single message (parallel where possible).
