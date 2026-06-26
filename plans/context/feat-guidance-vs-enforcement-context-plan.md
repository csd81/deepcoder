# feat: Separate guidance context from enforcement context

## Problem

DeepCoder currently builds project instructions and memory into the main system
prompt. That gives them high authority, even though repo instructions, memory,
skills, and hooks are not enforcement mechanisms.

The safer conceptual split is:

- deterministic policy enforces permissions, sandboxing, and sensitive paths;
- project instructions and memory guide behavior but cannot override policy.

Claude Code reportedly places CLAUDE.md as user-context rather than system
prompt content, creating a clearer separation between guidance and enforcement.

## Goal

Introduce explicit context authority levels and move mutable/project-local
guidance into a lower-authority context block, while preserving current behavior
behind a compatibility flag.

## Design

Context authority classes:

1. **System enforcement:** base DeepCoder behavior, safety rules, tool-use
   policy, permission reminders.
2. **Managed guidance:** admin/user configured durable guidance.
3. **Project guidance:** AGENTS/instructions/CLAUDE files.
4. **Memory guidance:** accepted `.deepcoder/memory` content.
5. **Ephemeral guidance:** todos, JIT instructions, delegation hints, hook
   context.

Target provider input:

```text
system: DeepCoder base prompt + non-negotiable safety/tool rules
user/system-context block: project guidance + memory + source attribution
conversation history...
ephemeral context...
```

Exact role choice should be provider-tested. If non-leading system messages
cause provider issues, use user-role context blocks with clear labels.

## Safety invariants

1. Moving guidance cannot weaken `checkPermission()`.
2. Project guidance cannot alter approval mode or sandbox.
3. Memory/skills/hooks are labeled advisory.
4. Feature flag can restore legacy system-prompt placement.
5. Flight recorder captures both variants for comparison.

## Tests

- base system prompt remains safety-authoritative.
- project instructions render in guidance block under flag.
- permission decisions are identical before/after relocation.
- prompt-injected project instruction cannot bypass deny.
- provider request shape remains valid for supported providers.

## Phasing

1. Add context authority renderer with legacy output.
2. Add flag to render project instructions as user-context guidance.
3. Move memory guidance.
4. Move skill activation blocks if safe.
5. Compare with flight recorder/evals before default-on.

## Status

**IMPLEMENTED (Phases 1–3, flag-gated, default off).** When `context.guidanceContext`
is on, project instructions + memory move OUT of the system prompt (`messages[0]`) and
the cache-optimized epoch snapshot into a lower-authority advisory `[project-guidance]`
block injected **ephemerally** each turn (via `withEphemeralContext`). The block carries
a "cannot override the permission model / sandbox / safety policy" header — guidance,
not enforcement.

Implementation notes:
- `renderGuidanceBlock(instructions, memory)` (`src/agent/systemPrompt.ts`) — advisory
  block with the non-authoritative header; "" when empty.
- `systemMessage` passes `instructions:""`/`memory:""` (omitting them from `messages[0]`)
  under the flag; `buildContextSnapshot` + `reconcileSessionContext` likewise exclude
  them from the epoch (so no `[context-update]` for guidance). `AgentDeps.guidanceContext`
  + a `repl` dep inject the block ephemerally.
- Config `context.guidanceContext` + `DEEPCODER_GUIDANCE_CONTEXT`, default off →
  byte-identical legacy (instructions in the system prompt). `checkPermission` is
  untouched — relocating guidance cannot weaken policy.
- Tests (`test/instruction-tiers-guidance.test.ts`): header/empty rendering, OFF keeps
  instructions in the prompt / ON omits them, ephemeral-not-persisted injection, and
  `[SECURITY]` a hostile instruction never reaches the high-authority system prompt
  under guidance mode. Phases 4–5 (move skill blocks, flight-recorder A/B before
  default-on) remain proposed.
