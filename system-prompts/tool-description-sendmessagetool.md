<!-- adapted-from: tool-description-sendmessagetool.md -->
Send a message to another agent. Your plain text output is NOT visible to other agents — you MUST call this tool to communicate.
- `to`: teammate name, "main" (main conversation — background agents only), or agentId from spawn result
- Messages from teammates are delivered automatically; no inbox checking needed
- When relaying, do not quote the original — it is already rendered to the user
