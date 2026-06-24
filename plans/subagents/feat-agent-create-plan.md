# Feature — `/agent-create` custom subagent definitions

## Context

Today deepcoder ships only **fixed built-in profiles**: `PROFILES` is a hardcoded
record of five `SubagentProfile`s (`reviewer, researcher, testTriage, explorer,
verifier`) in `src/subagents/profiles.ts:101`. A user cannot add a custom
delegate (e.g. "security-auditor", "perf-reviewer") without editing source. Each
profile is **read-only** — `allowedTools` are native read/context tools only
(`READ_ONLY_TOOLS`, `src/subagents/profiles.ts:8`), and the runner enforces this
twice: a `restrictedRegistry(profile.allowedTools)` (`runner.ts:33`,
`registry.ts:92` — MCP tools never included, unknown names ignored) AND
`mode: "readonly"` so a mis-listed mutating tool is still denied
(`runner.ts:11-16` comment). The anti-recursion rule is structural: subagent
`ToolContext` has no `delegate` runtime (`runner.ts:48-55`,
`sessionFactory.ts:216-220`), and `delegate`'s own profile enum
(`src/tools/delegateTool.ts:5`) excludes any delegating profile.

The on-disk precedent already exists for **skills**: `discoverSkills` scans
`~/.deepcoder/skills`, `~/.agents/skills`, `<ws>/.deepcoder/skills`,
`<ws>/.agents/skills` for `<name>/SKILL.md`, parsing YAML frontmatter via
`parseFrontmatter` (`src/skills/discovery.ts:14-57`, `src/skills/frontmatter.ts`).
`/skillify` already does model-draft → write-to-disk (`slashCommands.ts:1146-1200`).
`/agent-create` is the same shape for delegate profiles. Source prompt:
`system-prompts/agent-prompt-agent-creation-architect.md` (agent
architect: extract intent, design persona, output JSON `{identifier, whenToUse,
systemPrompt}`).

## Model

- On disk: `<root>/agents/<name>.md` under the same roots as skills (reuse the
  list), e.g. `.agents/agents/security-auditor.md`. Frontmatter + markdown body.
  - Frontmatter: `name`, `description` (required), `role` (one of
    `ModelRole`, default `review`), `maxTurns`, `contextBudgetTokens`,
    `allowedTools` (block/inline list), `webOptIn`. Body = `outputGuidance`.
- A **loader** parses these into `SubagentProfile`s and merges them into the
  registry: built-ins are the base; a disk def with the same name overrides
  (workspace wins over user, like skills precedence).
- `/agent-create <name> <description>` → model drafts the def (architect prompt)
  → show preview → on confirm, write the `.md` and report how to use it.
- **Invariants forced at load, never trusted from disk**: `allowedTools` is
  intersected with `READ_ONLY_TOOLS` (drop anything else); `delegate` is never
  permitted (no-recursion); generated/loaded profiles are usable wherever
  built-ins are (`/<name>` slash dispatch + the `delegate` tool).

## Design

### `src/subagents/customProfiles.ts` (new — loader; mirrors skills discovery)
```ts
import { READ_ONLY_TOOLS } from "./profiles.js"; // export it (see Files to change)
import { parseFrontmatter } from "../skills/frontmatter.js";
import { ALL_ROLES } from "../models/types.js";

/** Sanitize a disk-loaded def into a safe, read-only, non-recursive profile. */
export function sanitizeProfile(fm, body, fallbackName): SubagentProfile | null {
  const name = (fm.name?.trim()) || fallbackName;
  if (!fm.description?.trim()) return null;           // required, like skills
  const ro = new Set(READ_ONLY_TOOLS);
  // INTERSECT with READ_ONLY_TOOLS — strips edit_file/run_bash/delegate/MCP/etc.
  const allowedTools = (fm.allowedTools ?? READ_ONLY_TOOLS).filter((t) => ro.has(t));
  return {
    name, purpose: fm.description.trim(),
    allowedTools: allowedTools.length ? allowedTools : [...READ_ONLY_TOOLS],
    maxTurns: clampInt(fm.maxTurns, 1, 24, 12),
    contextBudgetTokens: clampInt(fm.contextBudgetTokens, 4000, 64000, 48000),
    role: ALL_ROLES.includes(fm.role) ? fm.role : "review",
    outputGuidance: body.trim() || undefined,
    webOptIn: fm.webOptIn === true,
  };
}

/** Discover + sanitize disk profiles, lowest→highest precedence (skills roots). */
export async function discoverCustomProfiles(workspaceRoot, home = os.homedir())
  : Promise<Record<string, SubagentProfile>> { /* scan <root>/agents/*.md */ }

/** Built-ins as base; disk defs override by name. Built-in NAMES are protected
 *  (a disk file named "reviewer" cannot shadow the built-in reviewer). */
export function mergeProfiles(builtins, custom): Record<string, SubagentProfile>
```
`frontmatter.ts` only parses `name/description/disableModelInvocation/userInvocable/
allowedTools` today (`frontmatter.ts:35-56`). Extend its `switch` (and
`SkillFrontmatter`, or add a tiny agent-specific parser) to also read `role`,
`maxTurns`, `contextBudgetTokens`, `webOptIn`. Prefer extending the shared parser
so the block-list logic (`frontmatter.ts:24-32`) is reused for `allowedTools`.

### `/agent-create` (new case in `slashCommands.ts` switch, near `skillify`)
Mirror `skillify` (`slashCommands.ts:1146-1200`): build the architect prompt from
`agent-prompt-agent-creation-architect.md` + the user's description, call
`session.provider.chat({ tools: [], model: config.model })`, parse JSON (strip
code fences like skillify does at `:1167`), preview the rendered `.md`, then
`confirm(...)` (`permissions/prompt.js`) before `fs.writeFile` to
`<ws>/.agents/agents/<name>.md`. Validate `name` with `assertSafeId`
(`workspace/paths.js`, already imported). On write, print usage: `/<name> <task>`
and "available to the `delegate` tool".

### Wiring (load-bearing — green-but-inert is a failed slice)
1. **`sessionFactory.ts:225`** — `buildDelegateRuntime` resolves `PROFILES[name]`.
   Replace with a session-held merged map: discover custom profiles at session
   build and store `session.profiles = mergeProfiles(PROFILES, custom)`; look up
   there. This makes custom profiles delegate-callable.
2. **`delegateTool.ts:5`** — the hardcoded `z.enum(PROFILES)` rejects custom
   names. Relax to `z.string()` and validate against the runtime map inside
   `execute` (`ctx.delegate.run` already throws "Unknown subagent profile" for
   misses, `sessionFactory.ts:226`), keeping the built-in names in the tool
   description.
3. **`slashCommands.ts` switch** — add a `default:`/fallback that, for an unknown
   `/<cmd>`, checks the merged profile map and runs it via the existing
   `runSubagentCommand` helper (`slashCommands.ts:3145`) exactly like
   `/review`/`/research` (`:649`,`:658`). Re-discover on demand (like `/skills`).

## Files to change
- **New:** `src/subagents/customProfiles.ts`, `test/agent-create.test.ts`,
  `test/custom-profiles-loader.test.ts`.
- **Edit:** `src/subagents/profiles.ts` (export `READ_ONLY_TOOLS`).
- **Edit:** `src/skills/frontmatter.ts` + `src/skills/types.ts` (parse `role`,
  `maxTurns`, `contextBudgetTokens`, `webOptIn`).
- **Edit:** `src/cli/slashCommands.ts` (`agent-create` case + unknown-command
  profile fallback).
- **Edit:** `src/runtime/sessionFactory.ts` (merge custom profiles; lookup map).
- **Edit:** `src/tools/delegateTool.ts` (accept custom profile names safely).

## Tests (RED first)
`test/custom-profiles-loader.test.ts` (temp workspace via `mkdtemp`, no mocks):
- A valid `.agents/agents/foo.md` loads as a profile (`role`, `maxTurns`,
  `outputGuidance` from body, `purpose` from `description`).
- **Invariant — read-only:** a def listing `edit_file`, `run_bash`, `write_file`
  → those are **stripped**; `allowedTools` ⊆ `READ_ONLY_TOOLS`.
- **Invariant — no recursion:** a def listing `delegate` → `delegate` is dropped.
- A def with no `description` is skipped (like a description-less skill).
- A disk file named `reviewer` does **not** override the built-in `reviewer`.
- Workspace def overrides a user def of the same custom name (precedence).
`test/agent-create.test.ts`:
- The architect prompt builder includes the user's description + the JSON shape.
- A parsed draft renders to a `.md` with valid frontmatter that
  `discoverCustomProfiles` round-trips into a sanitized profile.
- `delegate` with a custom profile name resolves via the merged map; an unknown
  name returns the "Unknown subagent profile" error (no throw to user).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green WITH the new tests.
2. Manual: `/agent-create security-auditor "find auth and injection bugs"` →
   preview → confirm → file at `.agents/agents/security-auditor.md`; then
   `/security-auditor <scope>` runs a read-only subagent, and the `delegate` tool
   accepts `profile: "security-auditor"`.

## Safety
- **Read-only invariant preserved:** loader intersects `allowedTools` with
  `READ_ONLY_TOOLS` — disk content can never grant `edit_file`/`run_bash`/
  `write_file`/MCP tools. Defence-in-depth holds: the runner still uses
  `restrictedRegistry` + `mode:"readonly"` (`runner.ts:33`, `:11-16`).
- **No-delegate-recursion preserved:** `delegate` is stripped from any loaded
  `allowedTools`, and subagent `ToolContext` still carries no `delegate` runtime
  (`runner.ts:48-55`) — a custom profile cannot spawn further subagents.
- **Built-in names protected:** a disk def cannot shadow `reviewer` et al.
- Writes go only to `<ws>/.agents/agents/<name>.md` with `assertSafeId(name)`;
  no path traversal. Creation is confirm-gated like a mutating op.

## Worker contract notes
- TDD: write the failing loader tests (read-only strip, no-`delegate`, missing
  description, built-in protection, precedence) FIRST, then implement. A green
  `--check phase` with ZERO new tests is a vacuous pass.
- Reuse the [[feat-skillify]] / skills-discovery pattern verbatim: same roots,
  same `parseFrontmatter` block-list logic, same `confirm`→`fs.writeFile` flow as
  `/skillify` (`slashCommands.ts:1146-1200`). Do NOT invent a new YAML parser.
- Wiring is mandatory and same-task: a profile that loads but is unreachable from
  `delegate` (`delegateTool.ts:5`) and the slash dispatch is a failed slice —
  anchor all three wiring points (`sessionFactory.ts:225`, `delegateTool.ts:5`,
  the slash `default:`).
- Adjacent: this is delegate-profile creation; [[feat-adapt-claude-prompts]] owns
  the architect source prompt under `system-prompts/`.
