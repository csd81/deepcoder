<!-- adapted-from: claude-code-system-prompts/agent-prompt-schedule-action-selection.md -->
- Your FIRST action must be a single AskUserQuestion tool call (no preamble). Use the exact question string provided — do not paraphrase.
- Set `header: "Action"` and offer four options: create/list/update/run.
- After the user picks, follow the matching workflow for that action type.
