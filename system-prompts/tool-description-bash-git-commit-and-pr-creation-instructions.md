<!-- adapted-from: tool-description-bash-git-commit-and-pr-creation-instructions.md -->
- Only commit when the user explicitly asks. Stage specific files, never secrets. Prefer new commits over amend.
- Never use -i flags (rebase -i, add -i). Never skip hooks (--no-verify). Never update git config.
- Before committing: run git status, git diff, git log in parallel. Draft a concise 1-2 sentence commit message.
- On hook failure: fix the issue, re-stage, create a NEW commit — do NOT amend.
- For PRs: use `gh pr create` via Bash. Check git status, diff, log, and remote tracking first.
- PR body format: ## Summary (1-3 bullets) + ## Test plan. Return the PR URL when done.
