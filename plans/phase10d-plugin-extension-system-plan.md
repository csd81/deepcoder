# Phase 10D — Plugin and Extension System

## Context

Deepcoder already has most of the building blocks that other agent CLIs package as plugins:

- skills (`src/skills/*`)
- lifecycle hooks (`src/hooks/*`)
- MCP servers (`src/mcp/*`)
- checks (`src/checks/*`)
- sandbox and workspace-isolation policy
- dependency-healing policy
- context/instruction behavior

Today those capabilities are configured directly through `.deepcoder/config.json`, local skill
folders, and project files. That works, but it does not give users a clean way to install,
version, enable, disable, audit, or share a bundle of related behavior.

This phase adds a plugin/extension system that packages existing primitives into a signed/trusted,
inspectable directory format. It should not introduce a parallel runtime; plugins are declarative
bundles that expand into existing Deepcoder config, skills, hooks, checks, and MCP definitions.

## Goals

- Add a plugin manifest format for bundling skills, hooks, checks, MCP servers, and defaults.
- Add discovery from user and workspace plugin directories.
- Add explicit trust/enable/disable controls.
- Add `/plugins` slash commands for listing, inspecting, enabling, disabling, and explaining what a plugin contributes.
- Merge plugin contributions into runtime config through deterministic precedence.
- Preserve existing safety: untrusted workspace plugins cannot execute hooks/MCP, secrets are never loaded from plugin files,
  and all executable contributions remain subject to sandbox/permission policy.

## Non-goals

- No public plugin marketplace in this phase.
- No network install from arbitrary URLs.
- No plugin code execution at load time.
- No binary/native plugin API.
- No automatic trust of workspace plugins.
- No plugin-specific secret storage.

## Plugin Directory Format

Supported roots, low to high precedence:

1. `~/.deepcoder/plugins/<name>/`
2. `~/.agents/plugins/<name>/` alias, for cross-agent compatibility
3. `<workspace>/.deepcoder/plugins/<name>/`
4. `<workspace>/.agents/plugins/<name>/` alias

Required manifest:

`plugin.json`

```json
{
  "schemaVersion": 1,
  "name": "typescript-strict",
  "displayName": "TypeScript Strict Workflow",
  "version": "0.1.0",
  "description": "Checks, hooks, and skills for strict TypeScript projects.",
  "author": "local",
  "homepage": "https://example.invalid",
  "capabilities": ["skills", "hooks", "checks"],
  "skills": [{ "path": "skills/ts-debug/SKILL.md" }],
  "checks": {
    "typecheck": { "command": "npm run typecheck", "timeoutMs": 120000 }
  },
  "hooks": {
    "PreToolUse": [
      { "name": "block-env", "matcher": "write_file", "command": "node hooks/block-env.mjs", "timeoutMs": 30000 }
    ]
  },
  "mcpServers": {},
  "configDefaults": {
    "sandbox": { "mode": "fast", "network": "off" }
  }
}
```

Rules:

- Paths are plugin-directory-relative.
- Paths must stay inside the plugin directory after realpath resolution.
- Manifest must validate with zod and fail closed on malformed fields.
- Unknown fields are ignored but surfaced by `/plugins inspect` as warnings.
- Plugin files are data/config only; no load-time execution.

## Trust Model

User plugins are trusted by default only when installed under the user's home plugin roots.

Workspace plugins are discovered but disabled until trusted:

```bash
/plugins trust <name>
/plugins untrust <name>
```

Trust record lives in user state, not the repo:

`~/.deepcoder/trust/plugins.json`

Trust key should include:

- plugin name
- absolute path
- manifest hash
- source: `user | workspace`

If a trusted plugin's manifest hash changes, trust is invalidated and the plugin becomes
`needs-review`.

Executable contributions from untrusted plugins are disabled:

- hooks ignored
- MCP servers ignored
- checks available only after trust if they execute commands
- skills from untrusted workspace plugins require the same confirmation path as workspace skills

## Discovery and Manifest Types

New module:

`src/plugins/types.ts`

```ts
export interface PluginManifest {
  schemaVersion: 1;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  capabilities: PluginCapability[];
  skills?: PluginSkillRef[];
  checks?: Record<string, CheckConfig>;
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
  mcpServers?: Record<string, McpServerConfig>;
  configDefaults?: PluginConfigDefaults;
}
```

New module:

`src/plugins/discovery.ts`

Exports:

```ts
discoverPlugins(workspaceRoot: string, home?: string): Promise<PluginSummary[]>;
loadPlugin(pluginDir: string): Promise<LoadedPlugin | PluginLoadError>;
```

Discovery should mirror skills precedence and duplicate-name behavior, but unlike skills it should
preserve shadowed plugins in `/plugins list --all` for audit.

## Config Composition

New module:

`src/plugins/compose.ts`

Inputs:

- base file config
- trusted/enabled plugins
- CLI/env overrides

Output:

- merged config fragments for existing `loadConfig`
- explainable provenance map

Precedence, low to high:

1. built-in defaults
2. enabled user plugins
3. enabled workspace plugins
4. `.deepcoder/config.json`
5. env vars
6. CLI flags

Rationale: explicit project config should beat plugin defaults; CLI/env remain strongest.

Conflicts:

- duplicate check names: higher precedence wins, warning recorded
- duplicate hook names under same event: both kept unless exact same command/name, then dedupe
- duplicate MCP names: higher precedence wins, warning recorded
- duplicate skill names: follow existing skill precedence, but annotate plugin source

## Plugin Commands

Extend `src/cli/slashCommands.ts`:

```text
/plugins                         list enabled/discovered plugins
/plugins list [--all]
/plugins inspect <name>          show manifest, capabilities, warnings, trust state
/plugins enable <name>
/plugins disable <name>
/plugins trust <name>
/plugins untrust <name>
/plugins explain                 show merged contributions and conflict resolution
```

Output must be bounded:

- max plugins shown by default: 50
- max manifest excerpt: 8KB
- max warnings: 20

No command should execute plugin hooks or MCP servers. These are management commands only.

## Skills Integration

Plugin skills should reuse the existing skill system rather than creating a second mechanism.

Approach:

- `discoverSkills` receives optional plugin-provided skill roots.
- Plugin skill paths are normalized into `SkillSummary` with source `user` or `workspace` plus optional `pluginName`.
- Activation still uses `activateSkill` and existing trust checks.

Type additions:

```ts
interface SkillSummary {
  pluginName?: string;
}
```

## Hooks Integration

Plugin hooks are merged into `HooksConfig` before runtime starts.

Rules:

- untrusted workspace plugin hooks are not loaded
- all hook commands still run through existing hook runner and sandbox
- plugin hook path references must be resolved relative to the plugin directory
- hook command may not embed provider keys; config validation should warn on key-looking literals

## MCP Integration

Plugin MCP server definitions are merged into existing `mcpServers`.

Rules:

- execute-mode MCP from workspace plugin requires trust
- readonly MCP from workspace plugin also requires trust in this phase, because it still spawns a process
- MCP commands are never started during `/plugins inspect`; startup remains in normal runtime init

## Checks Integration

Plugin checks are merged into existing `checks`.

Rules:

- command runs through the same classifier/sandbox path as normal checks
- workspace plugin checks require trust before execution
- check names must pass the existing check-name regex

## State Files

User state:

- `~/.deepcoder/plugins/enabled.json`
- `~/.deepcoder/trust/plugins.json`

Workspace state, optional:

- `.deepcoder/plugins/enabled.json` for project default enablement

Workspace enablement cannot imply trust. If a plugin is enabled but untrusted, executable
capabilities are inert and `/plugins` reports `enabled, needs trust`.

## Security Requirements

- No plugin load-time code execution.
- No path traversal out of plugin directory.
- No symlink escape from plugin directory.
- No secret values in plugin manifests.
- Workspace plugin trust invalidates on manifest hash change.
- Config provenance must show when a plugin contributed an executable command.
- A malformed plugin cannot block startup; it is skipped with a warning.
- A malicious plugin cannot override CLI/env options.
- Plugin-contributed hooks/MCP/checks are disabled in untrusted workspaces.

## Files

New:

- `src/plugins/types.ts`
- `src/plugins/manifest.ts`
- `src/plugins/discovery.ts`
- `src/plugins/trust.ts`
- `src/plugins/compose.ts`
- `test/adversarial/plugins.test.ts`

Edit:

- `src/config/fileConfig.ts`
- `src/config/config.ts`
- `src/skills/types.ts`
- `src/skills/discovery.ts`
- `src/cli/slashCommands.ts`
- `src/cli/main.ts` if startup needs plugin discovery before session construction
- `README.md` or `docs/plugins.md` if docs are split out

## Tests

No live model required.

1. Valid plugin manifest loads and normalizes relative paths.
2. Malformed plugin is skipped and warning is bounded.
3. Path traversal in skill/hook path is rejected.
4. Symlink escape from plugin dir is rejected.
5. Duplicate plugin names resolve by precedence, but shadowed plugins remain inspectable.
6. Plugin checks merge with correct precedence.
7. Plugin hooks merge and dedupe exact duplicates.
8. Plugin MCP definitions merge with correct precedence.
9. Workspace plugin executable capabilities are inert until trusted.
10. Trust invalidates when manifest hash changes.
11. Plugin skill appears in `/skills` catalog with plugin provenance.
12. `/plugins inspect` is bounded and never executes plugin commands.
13. Secret-shaped manifest values are redacted in warnings/output.
14. CLI/env overrides beat plugin defaults.

## Rollout

### 10D.1 — Manifest and Discovery

- Add zod schema, discovery roots, provenance, warnings.
- No config composition yet.

### 10D.2 — Trust and Enablement

- Add trust store and enabled/disabled state.
- Add `/plugins list|inspect|trust|untrust|enable|disable`.

### 10D.3 — Skills Packaging

- Allow plugin-provided skills to feed existing skill discovery.
- Add plugin provenance in `/skills` output.

### 10D.4 — Checks/Hooks/MCP Composition

- Merge trusted plugin contributions into existing config.
- Add conflict/provenance warnings.

### 10D.5 — Explain and Docs

- Add `/plugins explain`.
- Document authoring and security model.

## Acceptance Criteria

- Existing direct `.deepcoder/config.json` behavior remains compatible.
- A local user plugin can contribute a skill and a check.
- A workspace plugin is discovered but cannot execute anything until trusted.
- Manifest hash changes revoke trust.
- `/plugins inspect` clearly shows capabilities, paths, trust, and warnings.
- No plugin command executes during discovery or inspection.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should plugin enable/disable state be global, workspace-local, or both?
- Should plugin version constraints be enforced before a marketplace exists?
- Should plugin manifests support `commands` later, or keep commands represented as hooks/checks/MCP only?
- Should Deepcoder accept Codex/Claude/Gemini plugin/extension manifests through adapters later?
