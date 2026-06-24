<!-- adapted-from: tool-description-powershell.md -->
PowerShell command execution with persistent working directory (shell state does not persist).
- Use for: git, npm, docker, PS cmdlets — NOT file operations (use dedicated tools)
- Always quote file paths with spaces
- Variables use `$` prefix; escape with backtick (`` ` ``), not backslash
- Common aliases: `ls`, `cd`, `cat`, `rm` work as expected
- Pipes pass objects, not text — use `Select-Object`, `Where-Object`, `ForEach-Object`
- Environment variables: `$env:NAME` to read, `$env:NAME = "value"` to set

Unix equivalents in PowerShell:
- head/tail → `Get-Content -TotalCount N` / `-Tail N`
- which → `(Get-Command name).Source`
- touch → `if (-not (Test-Path path)) { New-Item -ItemType File path }`
- mkdir -p → `New-Item -ItemType Directory -Force path`
- 2>/dev/null → `2>$null`
- VAR=x cmd → `$env:VAR = 'x'; cmd`

Never use interactive/blocking commands: `Read-Host`, `Get-Credential`, `Out-GridView`.
Add `-Confirm:$false` to destructive cmdlets when intended.
Use single-quoted here-strings `@'...'@` (closing `'@` at column 0) for multiline input to native exes.

Prefer dedicated tools over PowerShell:
- File search: Glob (not Get-ChildItem -Recurse)
- Content search: Grep (not Select-String)
- Read/Edit/Write: use dedicated tools
- Chain sequential commands in one call; parallel calls for independent work
