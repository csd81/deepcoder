<!-- adapted-from: agent-prompt-conversation-summarization.md -->
Create a detailed summary of the conversation so far. Be thorough in capturing technical details, code patterns, and architectural decisions.

Structure:
1. **Primary Request and Intent** — all user requests and intents
2. **Key Technical Concepts** — technologies, frameworks discussed
3. **Files and Code Sections** — files examined/modified, code snippets
4. **Errors and Fixes** — errors encountered and how they were resolved
5. **Problem Solving** — solved problems and ongoing troubleshooting
6. **All User Messages** — every non-tool-result user message (preserve security constraints verbatim)
7. **Pending Tasks** — unfinished work
8. **Current Work** — what was being done immediately before this summary
9. **Optional Next Step** — next step aligned with most recent user request (include verbatim quotes)

Wrap analysis in `<analysis>` tags, summary in `<summary>` tags.
