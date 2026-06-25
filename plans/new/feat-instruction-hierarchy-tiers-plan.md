# feat: Explicit instruction hierarchy tiers

## Problem

deepcoder supports project instructions via `.deepcoder/instructions.md`,
`AGENTS.md`, `CLAUDE.md`, and the optional instruction graph. This is useful, but
the hierarchy is not yet expressed as clear managed/user/project/local/nested
tiers with explicit precedence and attribution.

Claude Code's reported CLAUDE.md hierarchy distinguishes managed, user, project,
local, and directory-specific instructions. That makes source, authority, and
override behavior easier to reason about.

## Goal

Make DeepCoder instruction loading explicitly tiered, attributed, and inspectable.

## Proposed tiers

1. **Managed:** administrator/org policy, e.g. `/etc/deepcoder/instructions.md`
   or configured managed path.
2. **User:** `~/.deepcoder/instructions.md`.
3. **Workspace project:** `.deepcoder/instructions.md`, `AGENTS.md`,
   `CLAUDE.md`.
4. **Local private:** `.deepcoder/instructions.local.md` or
   `AGENTS.local.md`, gitignored by convention.
5. **Nested/path-local:** directory-level instruction files loaded eagerly on
   workspace-to-cwd walk or JIT when files under that path are read.
6. **Imports:** safe `@include` expansions attributed to the including file.

## Design

Extend `InstructionSourceKind` and rendering:

```ts
type InstructionTier =
  | "managed"
  | "user"
  | "project"
  | "local"
  | "nested"
  | "import";
```

Render with source attribution:

```text
[instructions: project AGENTS.md]
...
[instructions: local .deepcoder/instructions.local.md]
...
```

Later tiers load after earlier tiers so they receive later-model attention, but
managed policy remains clearly labeled as higher authority.

## Safety invariants

1. Symlink/path confinement rules remain enforced.
2. Sensitive files cannot be loaded as instructions via symlink/import.
3. Imports stay within allowed roots and depth/byte caps.
4. Conflicts are warnings, not silent overwrites.
5. Instructions remain guidance, not permission policy.

## Tests

- tier precedence/order is deterministic.
- managed/user/project/local/nested sources are attributed.
- local private files load but are marked local.
- unsafe symlink/import is skipped.
- conflicts produce warnings.
- JIT nested source loads when a file under it is read.

## Phasing

1. Add tier type and discovery paths.
2. Render attributed tier blocks.
3. Add `/instructions` display by tier.
4. Add managed/user paths from config.
5. Migrate legacy loader to use tiered graph by default.

## Status

**Core IMPLEMENTED (pure, unwired); loader/system-prompt wiring is a focused
follow-up PR.** New `src/context/instructionTiers.ts`: a 5-tier model
(`managed > user > workspace > local > path`) with `tierRank`/`orderSources` (stable
precedence), `renderTiers` (attributed, byte-bounded), and `resolveIncludes`
(allowlist-gated, depth-capped, **cycle-detected** `@include` over an injected reader —
never loops/throws). Tests: `test/instructionTiers.test.ts` (7) +
`test/adversarial/instruction-tiers.test.ts` (5). Unwired → zero behavior change;
wiring it into the project-instruction loader + system prompt (touching the
cache-optimized epoch baseline) is behavior-changing and lands separately.
