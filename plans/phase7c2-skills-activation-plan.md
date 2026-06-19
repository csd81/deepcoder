# Deepcoder Phase 7C2 - Skills Activation

## Goal

Turn Phase 7C1 skills from a passive catalog into usable, auditable instruction bundles.

Current state:

- `src/skills/types.ts` defines `SkillFrontmatter` and `SkillSummary`.
- `src/skills/frontmatter.ts` parses basic YAML frontmatter.
- `src/skills/discovery.ts` discovers skills from user/workspace roots.
- `src/skills/catalogPrompt.ts` renders a bounded catalog.
- `/skills` lists discovered skills.

Missing:

- loading the full `SKILL.md` body on demand,
- explicit user activation,
- model-callable `activate_skill`,
- session persistence of activations,
- skill instruction injection into the conversation,
- trust handling for workspace skills,
- allowed-tool restriction enforcement for activated skills.

Phase 7C2 implements **instruction/reference-only activation**. Script-backed skills remain disabled.

## Source Learnings

Claude Code skills emphasize lazy loading: the model sees a compact catalog first, then loads a skill only when needed. Skills can be explicitly invoked with slash commands and can include supporting files. Claude also supports invocation controls, dynamic context, subagent execution, and skill-scoped hooks, but those are later layers.

Gemini CLI's skill design emphasizes explicit activation through the tool loop and user consent before workspace skills grant extra context.

Codex skills emphasize progressive disclosure and skill directories containing `SKILL.md` plus optional supporting folders.

Deepcoder 7C2 should therefore be conservative:

- discover broadly,
- load narrowly,
- record every activation,
- treat workspace skills as untrusted until approved,
- never let skill instructions override the permission model.

## Scope

In scope:

- `activate_skill` native session tool,
- `/skills activate <name> [arguments]`,
- shorthand `/$skill-name [arguments]`,
- full `SKILL.md` loading on activation,
- `$ARGUMENTS` substitution,
- activated skill records in session state,
- persisted activated skill metadata,
- bounded skill instruction injection into history,
- trust prompt for workspace skills,
- `disableModelInvocation` enforcement,
- `allowedTools` as a restriction only.

Out of scope:

- executing scripts,
- skill-scoped hooks,
- skill-scoped MCP,
- automatic implicit activation,
- subagent skill execution,
- marketplace/installing skills,
- live file watching,
- remote/HTTP skills.

## User Experience

```text
/skills
/skills reload
/skills activate code-review src/agent/agentLoop.ts
/$code-review src/agent/agentLoop.ts
```

Model-callable tool:

```json
activate_skill({ "name": "code-review", "arguments": "src/agent/agentLoop.ts" })
```

Activation result shown to the model:

```text
Skill activated: code-review
Source: workspace .deepcoder/skills/code-review/SKILL.md
Arguments: src/agent/agentLoop.ts

[skill instructions]
...
```

The activation message is normal conversation history. It is not global memory and does not affect future sessions unless the session is resumed.

## Data Types

Extend `src/skills/types.ts`:

```ts
export interface SkillDefinition extends SkillSummary {
  body: string;
  directory: string;
  allowedTools: string[];
  bodyBytes: number;
}

export interface ActivatedSkillRecord {
  name: string;
  path: string;
  source: "user" | "workspace";
  activatedAt: string;
  arguments: string;
  bodyHash: string;
  modelRequested: boolean;
}
```

Session adds:

```ts
activatedSkills: ActivatedSkillRecord[];
trustedWorkspaceSkills: Set<string>; // session-only approval cache, keyed by absolute SKILL.md path
```

Persist only `activatedSkills`, not `trustedWorkspaceSkills`.

## Skill Loading

Add `src/skills/activation.ts`:

```ts
loadSkillDefinition(summary: SkillSummary): Promise<SkillDefinition>
renderSkillActivation(def: SkillDefinition, args: string, opts): string
activateSkill(input, ctx): Promise<ActivationResult>
```

Rules:

- Re-read `SKILL.md` at activation time.
- Parse frontmatter/body using existing parser.
- Bound body bytes, default `64 KiB` hard cap before rendering.
- Substitute `$ARGUMENTS` and `${ARGUMENTS}` with the provided argument string.
- Redact secrets before returning text.
- If the skill file disappears or is malformed, return a tool error.
- Supporting files are not auto-loaded in 7C2.

## Trust Model

User skills:

- activation allowed by default,
- still cannot change permissions,
- still cannot read sensitive files.

Workspace skills:

- model-requested activation requires approval unless `skills.trustWorkspaceSkills` is true,
- user-invoked activation may also ask once per session unless trust is configured,
- non-TTY defaults to deny for workspace skills unless trusted in config.

`disableModelInvocation`:

- model-callable `activate_skill` refuses when true,
- explicit user slash invocation still works.

`allowedTools`:

- If a skill declares `allowedTools`, it can restrict the active tool registry for future model calls only while the skill is active.
- 7C2 may implement this as advisory metadata first if registry restriction is too invasive.
- It must never expand permissions or add tools.

Recommended v1: record `allowedTools` in the activation text and enforce only for future subagent/skill-runner phases. Do not claim enforcement unless implemented.

## Config

Extend `.deepcoder/config.json` shape:

```json
{
  "skills": {
    "enabled": true,
    "trustWorkspaceSkills": false,
    "catalogMaxChars": 4000,
    "activationMaxBytes": 65536,
    "disabled": []
  }
}
```

Env:

```text
DEEPCODER_SKILLS=1|0
DEEPCODER_SKILLS_TRUST_WORKSPACE=1|0
DEEPCODER_SKILLS_CATALOG_CHARS=4000
```

Defaults:

- enabled: true,
- trustWorkspaceSkills: false,
- catalogMaxChars: 4000,
- activationMaxBytes: 65536.

## Native Tool

Add `src/tools/activateSkill.ts`.

Tool kind: `session`.

Schema:

```ts
{
  name: string,
  arguments?: string
}
```

Execution:

1. Discover skills from current workspace.
2. Find enabled skill by exact name.
3. If not found, return error with available names.
4. Enforce `disableModelInvocation` when called by the model.
5. Enforce workspace trust approval.
6. Load and render skill body.
7. Push activation message into `ctx.history` or return text for agent loop to append.
8. Record `ActivatedSkillRecord` in session.

Implementation note:

Current tools only return `ToolResult`; they do not mutate the session except through `ToolContext`. Extend `ToolContext` with:

```ts
skills?: SkillRuntime;
```

or pass `activatedSkills` and an `activateSkill` callback similarly to checkpoint hooks. Keep the tool thin; put most logic in `src/skills/activation.ts`.

## Slash Commands

Extend `/skills`:

```text
/skills
/skills reload
/skills activate <name> [arguments]
```

Add shorthand:

```text
/$skill-name [arguments]
```

Behavior:

- `/skills` lists discovered skills and active status.
- `/skills reload` re-runs discovery; it does not mutate old activation messages.
- `/skills activate` uses the same activation path as the native tool but is marked `modelRequested: false`.
- Shorthand works only for `userInvocable: true` skills.

## Session Persistence

Edit `src/session/sessionStore.ts`:

- Persist `activatedSkills`.
- Restore records on resume.
- Do not re-read or re-inject changed skill bodies automatically.
- `/skills` should show when a previously activated skill path is missing or hash changed.

## System Prompt Catalog

7C1 currently has catalog rendering but may not inject it. 7C2 should inject the bounded catalog at startup if skills are enabled.

Rules:

- Catalog includes name + description only.
- Catalog says skills must be activated before use.
- Catalog should be absent when no skills exist.
- Catalog budget is controlled by config/env.
- Full skill bodies never enter startup prompt.

## Security Rules

- Skill instructions are untrusted project text, like `AGENTS.md`.
- Skill activation cannot override permissions, approvals, sandboxing, or sensitive-path guards.
- Skill body is redacted before insertion.
- Workspace skill activation is auditable and approval-gated.
- Skill supporting files are not auto-read.
- Scripts remain disabled.
- A skill cannot request MCP or shell access by frontmatter.

## Adversarial Tests

Add or extend `test/adversarial/skills.test.ts`:

1. Model-requested activation loads a user skill body and records activation.
2. `/skills activate` loads a skill body and records activation.
3. `disableModelInvocation` blocks the model tool but allows user slash activation.
4. Workspace skill requires approval by default.
5. Non-TTY workspace skill activation is denied unless trusted.
6. Skill body containing `.env`-looking secret is redacted before insertion.
7. `$ARGUMENTS` substitution is literal and cannot inject permissions.
8. Missing skill returns a bounded error with available names.
9. Malformed or disappeared `SKILL.md` returns a tool error, not a crash.
10. Session persistence restores activation records without reloading changed body text.
11. Catalog prompt includes descriptions only, never full body or references.
12. A malicious skill saying "ignore permissions" cannot make `write_file` run in readonly mode.
13. Scripts under `scripts/` are never executed in 7C2.
14. Duplicate skills still obey precedence.

## Acceptance

No-model gate:

```bash
npm run typecheck
npm run test:phase
```

Focused tests:

```bash
node --import tsx --test test/adversarial/skills.test.ts
```

Manual smoke:

1. Create `.deepcoder/skills/code-review/SKILL.md`:

```md
---
description: Review code changes for bugs, safety, and missing tests.
userInvocable: true
---
Review the change in $ARGUMENTS. Prioritize concrete bugs and missing tests.
```

2. Run:

```text
/skills
/skills activate code-review src/agent/agentLoop.ts
```

3. Confirm:

- activation text appears once in history,
- session persists activation metadata,
- restart/resume keeps metadata,
- no scripts run,
- no sensitive files are read.

Fake-provider smoke:

- model calls `activate_skill({name:"code-review", arguments:"src/x.ts"})`,
- tool result includes bounded skill body,
- subsequent model response can follow the skill.

## Implementation Order

1. Config types for `skills` block.
2. Extend skill types with `SkillDefinition` and `ActivatedSkillRecord`.
3. Implement `loadSkillDefinition` and `renderSkillActivation`.
4. Extend `Session` + `SessionSnapshot` persistence with `activatedSkills`.
5. Add `activate_skill` tool and register it.
6. Wire `ToolContext` runtime callback/state needed by activation.
7. Implement `/skills activate` and `/$skill-name`.
8. Inject bounded skill catalog into system prompt.
9. Add adversarial tests.
10. README + ROADMAP update.

## Suggested Subagent Split

Because this touches many surfaces, delegate in 4 smaller workers:

### Worker 1 - Activation Core

Files:

- `src/skills/types.ts`
- `src/skills/activation.ts`
- `test/skillsActivation.test.ts`

No CLI/tool/session changes.

### Worker 2 - Session + Tool

Files:

- `src/tools/activateSkill.ts`
- `src/tools/registry.ts`
- `src/tools/types.ts`
- `src/cli/repl.ts`
- `src/session/sessionStore.ts`
- tests.

### Worker 3 - Slash Commands + Catalog Injection

Files:

- `src/cli/slashCommands.ts`
- `src/agent/systemPrompt.ts`
- `src/cli/main.ts` or `repl.ts` startup wiring,
- tests.

### Worker 4 - Hardening + Docs

Files:

- `test/adversarial/skills.test.ts`
- `README.md`
- `ROADMAP.md`

Run full `test:phase` after each worker.

## Out of Scope for 7C2

- Script execution.
- Skill-scoped hooks.
- Skill-scoped MCP.
- Skill execution inside subagents.
- Automatic implicit skill selection.
- Remote skill installation.
- Marketplace.

## Follow-up 7C3

After 7C2 is stable:

- script-backed skills through sandbox runner,
- skill-scoped hooks,
- subagent skill execution (`context: fork`),
- dynamic context providers,
- trusted bundled skills.
