<!-- adapted-from: claude-code-system-prompts/agent-prompt-batch-slash-command.md -->
- **Phase 1 — Research & Plan**: Enter plan mode. Launch subagents to research scope. Decompose work into 5–30 self-contained, independently implementable units. Determine e2e test recipe (browser-automation, CLI verifier, dev-server+curl, or existing test suite). If none found, ask user for verification strategy.
- **Phase 2 — Spawn Workers**: After plan approval, launch one background agent per unit in parallel with `isolation: "worktree"`. Each prompt must be fully self-contained (goal, task, file list, conventions, test recipe, worker instructions).
- **Phase 3 — Track Progress**: Render status table with #, Unit, Status, PR columns. Re-render as completion notifications arrive. Final summary: "N/M units landed as PRs".
- DeepSeek-specific: workers inherit parent context but translate paths to worktree root. Prefer DeepSeek models for code generation tasks.
