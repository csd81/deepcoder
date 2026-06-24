<!-- adapted-from: agent-prompt-review-slash-command.md -->
Review a GitHub pull request. Gather context and diff via `gh` CLI:
1. `gh pr view <PR> --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels`
2. `gh pr diff <PR>` for the unified diff

The PR diff is the only review scope — local changes are out of scope. Present findings most-severe-first: `file:line — summary (failure scenario)`. Include a 2-3 sentence overview.
