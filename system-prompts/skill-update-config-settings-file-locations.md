<!-- adapted-from: skill-update-config-settings-file-locations.md -->
## Settings File Locations

Choose the appropriate file based on scope:

| File | Scope | Git | Use For |
|------|-------|-----|---------|
| `~/.config/deepcoder/settings.json` | Global | N/A | Personal preferences for all projects |
| `.deepcoder/settings.json` | Project | Commit | Team-wide hooks, permissions, plugins |
| `.deepcoder/settings.local.json` | Project | Gitignore | Personal overrides for this project |

Settings load in order: user -> project -> local (later overrides earlier).

## Settings Schema Reference

### Permissions
```json
{
  "permissions": {
    "allow": ["Bash(npm *)", "Edit(.deepcoder)", "Read"],
    "deny": ["Bash(rm -rf *)"],
    "ask": ["Write(/etc/*)"],
    "defaultMode": "default" | "plan" | "acceptEdits" | "dontAsk",
    "additionalDirectories": ["/extra/dir"]
  }
}
```

**Permission Rule Syntax:**
- Exact match: `"Bash(npm run test)"`
- Prefix wildcard: `"Bash(git *)"` — matches `git`, `git status`, `git commit`, etc.
- Tool only: `"Read"` — allows all Read operations

### Environment Variables
```json
{
  "env": {
    "DEBUG": "true",
    "MY_API_KEY": "value"
  }
}
```

### Model & Agent
```json
{
  "model": "deepseek-chat",
  "agent": "agent-name"
}
```

### Attribution (Commits & PRs)
```json
{
  "attribution": {
    "commit": "Custom commit trailer text",
    "pr": "Custom PR description text"
  }
}
```
Set `commit` or `pr` to empty string `""` to hide that attribution.

### MCP Server Management
```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["server1", "server2"],
  "disabledMcpjsonServers": ["blocked-server"]
}
```

### Other Settings
- `language`: Preferred response language (e.g., "japanese")
- `cleanupPeriodDays`: Days to keep transcripts before automatic cleanup
- `respectGitignore`: Whether to respect .gitignore (default: true)
- `syntaxHighlightingDisabled`: Disable diff highlighting
