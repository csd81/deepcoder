# Deepcoder Phase 7C - Agent Skills

## Goal

Add reusable task expertise to Deepcoder as "skills": small, discoverable instruction bundles with optional supporting files and scripts.

Skills should let users stop pasting the same workflow instructions into chat, for example:

- project-specific release checklist,
- preferred code review rubric,
- framework migration steps,
- incident triage workflow,
- benchmark case authoring rules,
- repeatable debugging procedure,
- domain conventions for a monorepo package.

This is not a replacement for MCP, hooks, project instructions, or subagents:

- Project instructions describe standing repository facts.
- Skills describe reusable procedures or specialized reference material.
- Hooks run deterministic lifecycle commands.
- MCP exposes external tools/resources.
- Subagents isolate read-only analysis roles.

## Cross-Agent Learnings

This plan is based on Codex, Gemini CLI, and Claude Code skill systems.

### Codex

Codex skills use progressive disclosure: the model initially sees only each skill's name, description, and path, then reads the full `SKILL.md` only when the skill is selected. Codex also caps the initial skill list budget so skills do not consume too much context. A skill is a directory with `SKILL.md` plus optional `scripts/`, `references/`, `assets/`, and `agents/`. Skills can be selected explicitly with `/skills` or `$skill`, or implicitly from the description.

Deepcoder lessons:

- Use progressive disclosure from day one.
- Keep the initial skill catalog token-bounded.
- Require concise `name` and `description` metadata.
- Support explicit invocation first; implicit selection can be conservative.
- Treat scripts and references as supporting resources, not automatically loaded prompt bulk.

### Gemini CLI

Gemini discovers skills from built-in, extension, user, and workspace tiers, with workspace skills highest precedence. It supports `.agents/skills/` as an interoperable alias. Activation is explicit in the tool loop: the model calls an activation tool, the user consents, then the skill body and folder access are added.

Deepcoder lessons:

- Use tiered discovery.
- Support `.agents/skills/` for cross-tool compatibility.
- Require user consent before activating workspace skills that grant file access.
- Add the skill directory to allowed read roots only after activation.
- Make activation auditable in the session transcript.

### Claude Code

Claude skills are `SKILL.md` files with YAML frontmatter and markdown instructions. They can include supporting files, scripts, templates, examples, and references. Skills can be personal, project, or plugin-scoped. Claude also supports user-only invocation controls, live change detection, argument substitution, and skill/subagent integration.

Deepcoder lessons:

- Use YAML frontmatter plus markdown body.
- Support optional `disableModelInvocation` for side-effectful skills.
- Support `$ARGUMENTS` substitution for explicit commands.
- Keep `SKILL.md` concise and load references only when needed.
- Integrate skills with subagents later, not in v1.
- Watch/reload can wait; add `/skills reload` first.

Sources:

- Codex skills: https://developers.openai.com/codex/skills
- Gemini CLI skills: https://geminicli.com/docs/cli/skills/
- Claude Code skills: https://code.claude.com/docs/en/skills

## Dependency

Recommended order:

1. Phase 7A fast sandboxing.
2. Phase 7B hooks.
3. Phase 7C skills.

Reason:

```text
skills may include scripts
scripts must run through sandboxing
hooks may later package/trigger skills
```

However, 7C can ship in two slices:

- 7C1: instruction/reference-only skills, no script execution.
- 7C2: script-backed skills after `SandboxRunner` is available.

## Skill Layout

Supported v1 locations:

```text
.deepcoder/skills/<skill-name>/SKILL.md
.agents/skills/<skill-name>/SKILL.md
~/.deepcoder/skills/<skill-name>/SKILL.md
~/.agents/skills/<skill-name>/SKILL.md
```

Precedence, lowest to highest:

```text
user ~/.deepcoder/skills
user ~/.agents/skills
workspace .deepcoder/skills
workspace .agents/skills
```

If duplicate names exist, the higher-precedence skill wins and `/skills` reports the shadowed source.

Directory shape:

```text
my-skill/
  SKILL.md
  references/
    api.md
  scripts/
    validate.sh
  assets/
    template.md
```

## SKILL.md Format

Frontmatter:

```yaml
---
name: code-review
description: Review a code change for correctness, safety, and missing tests.
disableModelInvocation: false
userInvocable: true
allowedTools:
  - read_file
  - grep
  - glob
---
```

Markdown body:

```markdown
Review the changed code. Prioritize bugs, regressions, security risks, and missing tests.

If supporting details are needed, read references/checklist.md.
```

Required:

- `description`

Optional:

- `name` defaults to directory name.
- `disableModelInvocation` defaults to `false`.
- `userInvocable` defaults to `true`.
- `allowedTools` defaults to no additional restriction.
- `maxInitialDescriptionChars` can be added later.
- `context: inline | fork` is deferred.
- skill-bundled MCP, hooks, subagents, and provider config are deferred.

## Discovery

Add `src/skills/discovery.ts`:

- scan configured skill roots,
- parse frontmatter,
- validate required metadata,
- ignore malformed skills with a warning,
- resolve duplicate names by precedence,
- return a `SkillSummary[]`.

`SkillSummary`:

```ts
type SkillSummary = {
  name: string;
  description: string;
  source: "user" | "workspace";
  path: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
};
```

Do not read supporting files during discovery.

## Progressive Disclosure

At startup, inject only a compact skill catalog into the system prompt:

```text
Available skills:
- code-review: Review a code change for correctness, safety, and missing tests.
- release-checklist: Prepare and verify a release.
```

Budget:

- default max catalog chars: `4000`,
- configurable as `DEEPCODER_SKILLS_CATALOG_CHARS`,
- truncate descriptions first,
- if still too large, include the highest-precedence skills first and show a warning in `/skills`.

Full `SKILL.md` body is loaded only after activation.

## Activation

Add a native session tool:

```text
activate_skill
```

Input:

```json
{ "name": "code-review", "arguments": "src/agent/agentLoop.ts" }
```

Behavior:

1. Find enabled skill by name.
2. Reject if `disableModelInvocation` and activation was model-requested.
3. For workspace skills, require approval on first activation unless trusted in config.
4. Read `SKILL.md`.
5. Render `$ARGUMENTS`.
6. Add a skill activation message to conversation.
7. Add the skill directory to the session's allowed read roots for supporting files.
8. Record activation in session state.

Manual invocation:

```text
/skills
/skills reload
/skills activate <name> [arguments]
/$skill-name [arguments]
```

For v1, support `/skills activate <name>` and `$skill-name` as explicit shortcuts. Full fuzzy selection UI can wait.

## Trust Model

Skills can influence model behavior. Treat workspace skills as untrusted until the user enables them.

Config:

```json
{
  "skills": {
    "enabled": true,
    "trustWorkspaceSkills": false,
    "roots": [],
    "disabled": ["deploy-prod"]
  }
}
```

Rules:

- User skills are allowed by default.
- Workspace skills are discoverable by default but require approval before activation.
- Skill activation never bypasses Deepcoder's permissions.
- Skill instructions cannot grant write/bash/MCP permissions.
- `allowedTools` can only restrict tools, not expand permissions.
- Supporting files are readable only inside the activated skill directory.
- Scripts are disabled in 7C1.
- Script execution in 7C2 must go through `SandboxRunner`.

## Session Persistence

Persist activated skills:

```json
{
  "activatedSkills": [
    {
      "name": "code-review",
      "path": "/repo/.agents/skills/code-review/SKILL.md",
      "activatedAt": "2026-06-19T..."
    }
  ]
}
```

On resume:

- re-discover skills,
- warn if an activated skill path disappeared or changed,
- do not silently reload changed instructions into history,
- keep the old activation message already stored in the transcript.

This matches the safer behavior: historical conversations should not mutate because a skill file changed later.

## V1 Files

- `src/skills/types.ts`
- `src/skills/frontmatter.ts`
- `src/skills/discovery.ts`
- `src/skills/activation.ts`
- `src/skills/catalogPrompt.ts`
- `src/tools/activateSkill.ts`
- edits to `src/tools/registry.ts`
- edits to `src/agent/systemPrompt.ts`
- edits to `src/cli/slashCommands.ts`
- edits to `src/cli/repl.ts`
- edits to `src/session/sessionStore.ts`
- tests under `test/skills.test.ts`
- adversarial tests under `test/adversarial/skills.test.ts`
- docs in `README.md` and `ROADMAP.md`

## V1 Slash Commands

```text
/skills
/skills reload
/skills activate <name> [arguments]
/$skill-name [arguments]
```

`/skills` shows:

- active/inactive,
- source path,
- whether workspace approval is required,
- whether model invocation is disabled,
- whether the skill is shadowing another skill.

## Script-Backed Skills - 7C2

After sandboxing exists, enable scripts referenced by a skill.

Rules:

- scripts must be inside the skill directory,
- script paths are resolved with realpath and confined,
- scripts run through `SandboxRunner`,
- script output is bounded and redacted,
- scripts cannot receive secrets unless explicitly configured,
- side-effectful scripts should require approval unless the user allowlists them.

No `scripts/` auto-execution in 7C1.

## Subagent Integration - Later

After v1 works, allow:

```yaml
context: fork
agent: reviewer
```

This would run a skill in an isolated subagent context. Defer because it touches trust boundaries, context persistence, and result quarantine.

## Adversarial Tests

Add `test/adversarial/skills.test.ts`:

1. A skill cannot expand permissions beyond current mode.
2. A workspace skill requires approval before activation.
3. `disableModelInvocation` blocks model-requested activation but allows user invocation.
4. Duplicate names obey precedence and report shadowed skills.
5. Malformed frontmatter is ignored with a warning, not a crash.
6. Supporting file reads are confined to the activated skill directory.
7. `$ARGUMENTS` substitution is escaped and cannot inject extra tool permissions.
8. Skill catalog truncation keeps system prompt under the configured budget.
9. A malicious skill instruction saying "ignore permissions" has no effect.
10. Session resume does not silently reload changed skill text into old history.
11. A skill cannot read `.env` or other sensitive paths through supporting file access.
12. Script-backed skills stay disabled in 7C1.

## Acceptance

No-model gate:

- `npm run typecheck`
- `npm run test:phase`
- skill discovery unit tests pass,
- adversarial skill tests pass,
- `/skills` works in a fixture workspace,
- model-requested `activate_skill` works through a fake provider,
- workspace trust prompts are covered by tests.

Live smoke:

1. Create `.agents/skills/local-bench-hardening/SKILL.md`.
2. Ask Deepcoder to improve a local-bench case.
3. Confirm it sees only the catalog at first.
4. Confirm it activates the skill.
5. Confirm the skill guidance enters history.
6. Confirm no supporting references load until explicitly read.

## Out of Scope

- skill marketplace,
- installing skills from GitHub,
- record-and-replay skill creation,
- plugin-bundled skills,
- remote/HTTP skills,
- skill-bundled MCP servers,
- skill-bundled hooks,
- automatic live file watching,
- skill execution in subagents,
- script execution before sandboxing.

## Implementation Order

1. Types and frontmatter parser.
2. Discovery across user/workspace roots with precedence.
3. Catalog prompt injection with char budget.
4. `/skills` and `/skills reload`.
5. `activate_skill` native tool and activation message.
6. Manual `$skill-name` or `/skills activate` command.
7. Session persistence for activated skills.
8. Adversarial tests.
9. README and ROADMAP updates.
10. Live smoke with one local workspace skill.

## First Built-In Example Skills

Ship examples as docs or fixtures, not enabled by default:

- `local-bench-author`: instructions for writing hard local-bench cases.
- `swebench-analysis`: workflow for interpreting SWE-bench telemetry.
- `safe-refactor`: checklist for small behavior-preserving refactors.
- `code-review`: bug-first review rubric matching Deepcoder's subagent review style.

