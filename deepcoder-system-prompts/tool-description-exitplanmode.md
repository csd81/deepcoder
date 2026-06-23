<!-- adapted-from: tool-description-exitplanmode.md -->
Call when in plan mode and the plan is written and ready for user approval.
- Plan must already be written to the plan file (read from file, not passed as parameter)
- Only use when the task requires planning implementation steps of code
- For research/exploration: do NOT use this tool
- Resolve open questions with AskUserQuestion before calling this
- Do not ask "is this plan okay?" — that is what this tool does
