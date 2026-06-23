# Audit: Permission system

## Scope
`src/permissions/` — command classifier, policy, approval prompt, TTY gating, trust gate.

## What to verify

### Command classifier (`commandClassifier.ts`)
- Does it block all known dangerous patterns? (substitution, pipe-to-shell, redirects outside workspace, fork bombs, `curl | sh`, `sudo`, `chmod`, `rm -rf /`)
- Are there bypasses using shell-specific syntax? (bash `$()` vs backtick, PowerShell vs cmd vs bash on Windows)
- Does the segmenting parser handle quoted strings correctly? Can `rm "safe file"` be confused with `rm safe file`?
- What about `git -c core.fsmonitor='malicious' status`? Arbitrary exec via git config params?
- Is there a fuzz test suite that feeds random strings to the classifier?

### Approval modes (policy.ts)
- Is `readonly` truly read-only? Can a tool bypass the kind check?
- Is `yolo` correctly forcing containment ON and disabling escape hatches?
- Does the approval prompt show a diff for every mutate tool?
- Is the diff preview bounded? (can a model craft a huge diff to hide malicious changes?)

### Sensitive-path guard (`sensitive.ts`)
- Does it cover all common secret file patterns? (.env, .env.*, .deepcoder/, *key*.pem, *credential*, *secret*)
- Can symlinks bypass it? (AGENTS.md -> .env)
- Is there a TOCTOU race? (check path, then read — file replaced between check and read)

### Trust gate
- How are MCP servers trusted? Can a malicious MCP server bypass the "readonly" mode label?
- How are workspace skills trusted? Is the default "untrusted" actually enforced?

## Deliverables
- List of all known bypass techniques and whether each is blocked
- Fuzz test corpus for the command classifier
- Suggested regex/path additions for sensitive.ts
- Coverage gaps in the test suite
