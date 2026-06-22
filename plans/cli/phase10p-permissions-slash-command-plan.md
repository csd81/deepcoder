# Phase 10P — `/permissions` Unified Permission Center

## Context

Deepcoder has several separate safety controls:

- `/mode` for approval mode
- `/sandbox` for risky command isolation and network posture
- `/hooks` for lifecycle hooks
- `/plugins trust|untrust` for plugin enablement
- `mcpExecuteEnabled` for MCP execute tools
- `web.enabled` and subagent web access gates
- command classifier policy for checks and shell commands

These are powerful, but scattered. Users need one place to answer: "what can the agent do right now?" and "why was this tool/check allowed, asked, denied, sandboxed, or blocked?"

The next highest-ROI missing slash command is `/permissions`: a unified read-only permission center with a small set of safe session-local toggles.

## Goal

Add:

```text
/permissions
/permissions --json
/permissions explain <command>
/permissions mode <ask|auto|readonly>
/permissions sandbox <off|fast|local|bubblewrap>
/permissions network <on|off>
/permissions hooks <enable|disable>
/permissions mcp-execute <on|off>
/permissions web <on|off>
```

Default `/permissions` should summarize:

- approval mode
- sandbox mode/backend/network/fallback
- workspace isolation mode
- command policy status
- check command policy summary
- MCP read/execute status
- hooks status
- web status
- plugin trust counts
- skill trust posture

## Non-Goals

- No new permission backend.
- No OS sandbox changes.
- No policy file format changes.
- No persistent config rewrite in v1.
- No broad plugin trust management beyond linking to `/plugins`.
- No provider/model routing.
- No running checks/hooks/MCP tools.
- No auto-fix.

## UX

Status:

```text
/permissions

Permissions
  approval mode: ask
  sandbox: fast -> bubblewrap · network off · fallback ask
  workspace isolation: off
  MCP: readonly tools enabled · execute tools disabled
  hooks: disabled
  web: disabled
  plugins: 3 discovered · 1 trusted · 2 untrusted
  checks: 4 configured · 0 denied · 1 asks

Use /permissions explain <command> to inspect command policy.
```

Explain:

```text
/permissions explain npm run test:phase

command: npm run test:phase
policy: ask
reason: command is not on the auto-allow list
sandbox: would run with fast -> bubblewrap, network off
```

JSON:

```json
{
  "approvalMode": "ask",
  "sandbox": { "mode": "fast", "backend": "bubblewrap", "network": "off" },
  "mcp": { "executeEnabled": false },
  "web": { "enabled": false },
  "checks": { "total": 4, "allow": 0, "ask": 4, "deny": 0 }
}
```

Session-local toggles:

```text
/permissions mode readonly
/permissions sandbox fast
/permissions network off
/permissions hooks disable
/permissions web on
```

All toggles mutate only the live session config, matching the existing `/mode`, `/sandbox`, and `/hooks` behavior.

## Design

### 1. Pure permission summary

New file: `src/permissions/summary.ts`

```ts
export interface PermissionSummary {
  approvalMode: ApprovalMode;
  sandbox: {
    mode: SandboxMode;
    backend: string;
    backendOk: boolean;
    network: "on" | "off";
    fallback: string;
  };
  workspaceIsolation: {
    mode: string;
    backend?: string;
  };
  mcp: {
    servers: number;
    executeEnabled: boolean;
    executeTools: number;
    readonlyTools: number;
  };
  hooks: {
    enabled: boolean;
    configured: number;
  };
  web: {
    enabled: boolean;
    searchProvider: string;
  };
  plugins: {
    discovered: number;
    trusted: number;
    untrusted: number;
  };
  checks: {
    total: number;
    allow: number;
    ask: number;
    deny: number;
  };
}
```

Export:

```ts
export async function buildPermissionSummary(input: PermissionSummaryInput): Promise<PermissionSummary>;
export function formatPermissionSummary(summary: PermissionSummary): string;
export function explainCommandPermission(input: ExplainCommandInput): CommandPermissionExplanation;
export function formatCommandPermissionExplanation(x: CommandPermissionExplanation): string;
```

Inputs are explicit and injectable:

- config
- MCP status snapshot
- plugin discovery function
- plugin trust loader
- command classifier
- sandbox backend resolver

### 2. Command explanation

`/permissions explain <command>` should use the existing command policy stack:

- `classifyCommand(command)`
- `resolveBackend(config.sandbox.mode, config.sandbox.fallback)`
- current approval mode

It should not execute the command.

Output fields:

- raw command, bounded
- classifier decision: allow/ask/deny
- approval mode
- whether the command would require approval
- sandbox backend/mode/network
- warning if sandbox resolution fails closed

### 3. Slash command

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "permissions":
  await runPermissionsSlash(session, arg);
  return { consumed: true };
```

Parsing:

- no args: print summary
- `--json`: print summary JSON
- `explain <command>`: print command explanation
- `mode <ask|auto|readonly>`: same as `/mode`
- `sandbox <off|fast|local|bubblewrap>`: same as `/sandbox`
- `network <on|off>`: same as `/sandbox network`
- `hooks <enable|disable>`: same as `/hooks`
- `mcp-execute <on|off>`: session-local `config.mcpExecuteEnabled`
- `web <on|off>`: session-local `config.web.enabled`

Invalid subcommands print usage and do not mutate.

### 4. Relationship to existing commands

Keep existing commands:

- `/mode`
- `/sandbox`
- `/hooks`
- `/web`
- `/plugins`
- `/mcp`

`/permissions` is the consolidated view and convenience surface. Existing commands remain the detailed pages.

### 5. Slash catalog/help

Edit if present:

- `src/cli/slashCatalog.ts`
- `/help` text in `src/cli/slashCommands.ts`

Add:

```text
/permissions [explain|mode|sandbox|network|hooks|mcp-execute|web]  inspect and adjust live permissions
```

## Safety

- `/permissions` is read-only by default.
- Toggles are session-local only.
- No config-file writes.
- No command execution.
- No MCP server spawn.
- No hook execution.
- No plugin execution.
- No web call.
- Command explanation must redact secrets and bound displayed commands.
- JSON output must not include environment values or API keys.

## Tests

New file: `test/adversarial/permissions-slash.test.ts`

Pure summary tests:

1. Summary counts allow/ask/deny check commands.
2. Denied check commands appear in deny count.
3. Sandbox backend failure is represented without throwing.
4. MCP execute-disabled state appears clearly.
5. Web enabled/disabled state appears clearly.
6. Plugin trust counts are computed without executing plugins.
7. Formatter output is bounded and deterministic.
8. JSON summary contains no secrets.

Command explanation tests:

9. Safe command explains `allow` or `ask` according to classifier.
10. Dangerous command explains `deny`.
11. Secret-looking command is redacted in output.
12. Sandbox fail-closed explanation shows that it would refuse.

Slash tests:

13. `/permissions` prints summary.
14. `/permissions --json` parses as JSON.
15. `/permissions explain npm run test` does not execute the command.
16. `/permissions mode readonly` mutates session mode only.
17. `/permissions sandbox fast` mutates session sandbox mode only.
18. `/permissions network off` mutates session sandbox network only.
19. `/permissions web on` mutates session web flag only.
20. Invalid subcommand leaves session unchanged.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/permissions-slash.test.ts
```

Manual smoke:

```text
/permissions
/permissions --json
/permissions explain npm run test:phase
/permissions mode readonly
/permissions sandbox fast
/permissions network off
/permissions web off
```

Expected:

- no API keys printed
- no command executed by `explain`
- existing `/mode`, `/sandbox`, `/hooks`, `/web`, `/mcp`, `/plugins` still work
- toggles affect only the current session

## Delegation Suitability

Good split:

1. Worker A: pure `src/permissions/summary.ts` + tests.
2. Parent/manual: slash command wiring in `slashCommands.ts`.

Reason: the summary core is low-risk and testable. The slash command touches a large shared file and should be reviewed carefully.

Suggested worker prompt:

```text
Implement Phase 10P permission summary core only.
Touch only:
- src/permissions/summary.ts
- test/adversarial/permissions-slash.test.ts
Do not wire the slash command yet.
Do not execute commands, hooks, MCP, plugins, web, or model calls.
Run npm run test:phase.
```

## Implementation Order

1. Add pure summary/explain core.
2. Add tests for summary and command explanation.
3. Wire `/permissions` read-only summary and `--json`.
4. Wire `explain <command>`.
5. Wire session-local toggles.
6. Add slash catalog/help entry.
7. Run full gate.
