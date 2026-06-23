<!-- adapted-from: claude-code-system-prompts/agent-prompt-recent-message-summarization.md -->
- Summarize only the RECENT portion of the conversation (messages following earlier retained context). Earlier messages are kept intact.
- Sections: (1) Primary Request and Intent, (2) Key Technical Concepts, (3) Files and Code Sections (include full snippets), (4) Errors and Fixes, (5) Problem Solving, (6) All user messages verbatim (preserve security-relevant instructions), (7) Pending Tasks, (8) Current Work, (9) Optional Next Step with direct quotes.
- Wrap analysis in `<analysis>` tags before providing final summary in `<summary>` tags.
- Preserve security-relevant instructions or constraints verbatim so they remain in effect after compaction.
