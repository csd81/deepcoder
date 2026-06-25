# feat: PreCompact and PostCompact lifecycle hooks

## Problem

DeepCoder has hooks for tool use, session lifecycle, prompts, checks, and solve
attempts, but not for context shaping/compaction. As the context pipeline grows,
users and integrations need observability around when and why context was reduced.

Claude Code reportedly supports compaction-related hooks such as PreCompact and
PostCompact.

## Goal

Add compaction lifecycle hooks that observe and optionally annotate context
reduction without weakening safety or letting hooks rewrite arbitrary history.

## Hook events

Add:

- `PreCompact`
- `PostCompact`
- optionally later: `ContextProjection`

`PreCompact` input:

```ts
{
  beforeTokens: number;
  triggerTokens: number;
  force: boolean;
  stage: "auto" | "manual" | "overflow-recovery";
}
```

`PostCompact` input:

```ts
{
  beforeTokens: number;
  afterTokens: number;
  stages: ContextStageStats[];
  summaryPreview?: string;
}
```

## Behavior

Phase 1:

- hooks are advisory only,
- may return warnings,
- may inject bounded context only after compaction as a guidance note,
- cannot block compaction.

Phase 2:

- allow `PreCompact` to add bounded compaction instructions for optional deep
  compact only, not for deterministic automatic summary.

## Safety invariants

1. Hooks cannot prevent required overflow recovery compaction.
2. Hooks cannot access raw hidden `.deepcoder/**` artifacts unless already
   allowed by normal hook process environment.
3. Hook output is bounded and redacted.
4. Hook context injection is advisory.
5. Hook failures never break compaction.

## Tests

- PreCompact/PostCompact fire for manual `/compact`.
- hooks fire for automatic compaction.
- hook warnings are surfaced.
- hook context injection is bounded.
- throwing/timing-out hook does not prevent compaction.
- overflow recovery cannot be blocked by hook.

## Phasing

1. Add hook event types and schemas.
2. Fire hooks around current `compactIfNeeded()`.
3. Include stage stats after five-stage pipeline lands.
4. Add `/hooks` diagnostics for compaction events.
5. Optional deep-compact instruction injection.

## Status

**Phase 1 IMPLEMENTED** (PreCompact + PostCompact advisory hooks). Phase 2
(deep-compact instruction injection) and `/hooks` diagnostics remain proposed.

Implementation notes:
- `HookEvent` gained `PreCompact` and `PostCompact` (`src/hooks/types.ts`);
  `PostCompact` is in `CONTEXT_EVENTS` (may inject a bounded advisory note).
  Added `PreCompactInput` / `PostCompactInput` payload types.
- `AgentDeps.onPreCompact?` / `onPostCompact?` (advisory; return `AdvisoryOutcome`).
  Fired in `runAgentLoop` around the pipeline: PreCompact when history is over the
  trigger (`beforeTokens > triggerTokens`), PostCompact after with real
  `before/after` tokens + per-stage `stages` + a redacted `summaryPreview`.
- PostCompact's returned `context` is injected as a **one-shot** system guidance
  note into THIS model call only (reassigned, not pushed — `messagesForQuery` can
  alias canonical `messages`, so a push would wrongly persist it). Warnings surface
  via `onNotice`.
- **Advisory-only / cannot block:** a throwing or hostile hook is swallowed
  (notice emitted) and the model call + compaction still proceed. Wired in `repl.ts`
  via `runAdvisoryHooks` (bounded, redacted, timed-out by the existing engine).
- Tests: `test/compaction-hooks.test.ts` (5 — both fire with real stats on auto
  compaction, don't fire under budget, PostCompact context reaches the model but is
  not persisted, warnings surfaced, and `[SECURITY]` throwing/blocking hook cannot
  break or block compaction).
