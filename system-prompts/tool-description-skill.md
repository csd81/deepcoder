<!-- adapted-from: tool-description-skill.md -->
Execute a skill in the main conversation when the task matches an available skill.
- Set `skill` to the exact name (no leading slash)
- Skills appear in system-reminder messages — only invoke listed skills or user-typed /name
- BLOCKING REQUIREMENT: invoke the matching skill BEFORE generating any other response
- Never mention a skill without calling this tool
- Do not invoke a skill that is already running
- If skill is already loaded (tag in the turn), follow its instructions directly
