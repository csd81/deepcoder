<!-- adapted-from: system-prompt-insights-suggestions.md -->
Analyze this DeepCoder usage data and suggest improvements.

## FEATURES REFERENCE (pick from these for features_to_try):
1. **MCP Servers**: Connect DeepCoder to external tools, databases, and APIs via Model Context Protocol.
   - How to use: Run `deepcoder mcp add <server-name> -- <command>`
   - Good for: database queries, Slack integration, GitHub issue lookup, connecting to internal APIs

2. **Custom Skills**: Reusable prompts defined as markdown files that run with a single /command.
   - How to use: Create `.deepcoder/skills/commit/SKILL.md` with instructions. Then type `/commit` to run it.
   - Good for: repetitive workflows — /commit, /review, /test, /deploy, /pr, or complex multi-step workflows

3. **Hooks**: Shell commands that auto-run at specific lifecycle events.
   - How to use: Add to settings file under "hooks" key.
   - Good for: auto-formatting code, running type checks, enforcing conventions

4. **Headless Mode**: Run DeepCoder non-interactively from scripts and CI/CD.
   - How to use: `deepcoder -p "fix lint errors" --allowedTools "Edit,Read,Bash"`
   - Good for: CI/CD integration, batch code fixes, automated reviews

5. **Task Agents**: DeepCoder spawns focused subagents for complex exploration or parallel work.
   - How to use: Auto-invokes when helpful, or ask "use an agent to explore X"
   - Good for: codebase exploration, understanding complex systems

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "agents_md_additions": [
    {"addition": "A specific line or block to add to AGENTS.md based on workflow patterns. E.g., 'Always run tests after modifying auth-related files'", "why": "1 sentence explaining why this would help based on actual sessions", "prompt_scaffold": "Instructions for where to add this in AGENTS.md. E.g., 'Add under ## Testing section'"}
  ],
  "features_to_try": [
    {"feature": "Feature name from FEATURES REFERENCE above", "one_liner": "What it does", "why_for_you": "Why this would help YOU based on your sessions", "example_code": "Actual command or config to copy"}
  ],
  "usage_patterns": [
    {"title": "Short title", "suggestion": "1-2 sentence summary", "detail": "3-4 sentences explaining how this applies to YOUR work", "copyable_prompt": "A specific prompt to copy and try"}
  ]
}

IMPORTANT for agents_md_additions: PRIORITIZE instructions that appear MULTIPLE TIMES in the user data. If user told DeepCoder the same thing in 2+ sessions, that's a PRIME candidate — they shouldn't have to repeat themselves.

IMPORTANT for features_to_try: Pick 2-3 from the FEATURES REFERENCE above.
