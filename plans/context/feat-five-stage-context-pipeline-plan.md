# feat: Five-stage pre-model context pipeline

## Problem

deepcoder currently has one main automatic compaction path:

- `runAgentLoop()` calls `compactIfNeeded()` before each model call.
- `compactIfNeeded()` replaces older history with one deterministic
  `[compacted-summary]` message and keeps a recent tail.
- Large individual tool results are capped/offloaded in the loop via
  `MAX_TOOL_RESULT_BYTES` and `read_managed_output`.
- The loop adds soft nudges for high token use and excessive read volume.

This is workable, deterministic, and cheap, but it treats several different
context-pressure problems as one problem:

- One huge tool result should be offloaded, not force whole-history compaction.
- Repeated/obsolete exploration should be reduced before summarizing unique work.
- Long sessions need cheap temporal trimming before expensive semantic summaries.
- Cache-oriented context updates should not be destroyed unnecessarily.
- Full summarization should be the last resort, not the first serious reducer.

The Claude Code report describes a five-stage pre-model pipeline: budget
reduction, snip, microcompact, context collapse, and auto-compact. DeepCoder does
not need to clone those mechanisms exactly, but it should adopt the same design
principle: apply progressively stronger context shapers in a fixed order, using
the cheapest and least lossy reducer that can solve the current pressure.

## Goal

Replace the single automatic compaction entry point with a staged,
deterministic-first context pipeline:

```text
before every model call
  1. Budget reduce      cap/offload oversized individual artifacts
  2. Trident reduce     remove/stub redundant or obsolete history
  3. Snip tail project  preserve task + recent tail + protected state
  4. Context collapse   read-time virtual projection for very long sessions
  5. Auto compact       deterministic summary, optional explicit deep compact
```

The pipeline must preserve current safety invariants: no permission changes, no
model-visible access to `.deepcoder/**`, no orphaned tool calls/results, no live
model required for automatic compaction, and no loss of protected task/error/write
state.

## Relationship to existing plans

- `plans/new/feat-trident-compaction-plan.md` becomes Stage 2.
- `plans/context/feat-better-compaction-plan.md` covers parts of Stage 5 and the
  optional explicit `/compact --deep`.
- `plans/new/feat-append-oriented-session-storage-plan.md` provides the durable
  event substrate that will make Stage 4 read-time projection cleaner.
- `plans/new/feat-flight-recorder-plan.md` should be used to measure behavior
  before/after the pipeline on exact model payloads.

This plan is the umbrella that sequences those pieces into one pre-model
pipeline.

## Architecture

Create a new orchestrator:

```ts
// src/context/pipeline.ts
export interface ContextPipelineOptions {
  budgetTokens: number;
  compactAt: number;
  todos: Todo[];
  readTracker: Set<string>;
  writeTracker: Set<string>;
  force?: boolean;
  features: {
    budgetReduce: boolean;
    trident: boolean;
    snip: boolean;
    collapse: boolean;
    autoCompact: boolean;
  };
}

export interface ContextPipelineResult {
  changed: boolean;
  before: number;
  after: number;
  stages: ContextStageStats[];
  compacted: boolean;
}

export function shapeContextBeforeModel(
  messages: AgentMessage[],
  opts: ContextPipelineOptions,
): ContextPipelineResult
```

`runAgentLoop()` should call this instead of directly calling `compactIfNeeded()`.
For early phases, `shapeContextBeforeModel()` can delegate to existing
`compactIfNeeded()` after running new lighter stages.

## Stage 1 — Budget reduce

Purpose: handle oversized individual artifacts without summarizing the whole
conversation.

Current state:

- `capToolResult()` caps stored tool results.
- Very large outputs are saved with `saveManagedOutput()` and referenced by ID.

Expand this into an explicit pre-model stage:

- Scan tool messages for content above a lower configurable soft cap.
- Replace large content with a stable managed-output reference if not already
  offloaded.
- Preserve tool-call pairing by keeping the tool message and `toolCallId`.
- Never offload system prompts, user requests, compact summaries, or hook context.
- Make offloading idempotent: an already-offloaded message is unchanged.

Why first: it is local, cheap, and avoids penalizing the whole session for one
oversized command or file read.

## Stage 2 — Trident reduce

Purpose: reduce redundant/obsolete context before temporal trimming.

Use `plans/new/feat-trident-compaction-plan.md`:

- Supersede obsolete file reads and duplicate searches.
- Collapse pure exploration runs.
- Cluster repeated identical diagnostic failures.
- Preserve system messages, original task, last write per file, pending todos,
  last error, and provider tool-call pairing.

Why second: it can often get under budget while preserving more raw recent history
than summarization.

## Stage 3 — Snip tail project

Purpose: cheap temporal trimming when the session is too deep but does not yet
need semantic summarization.

Design:

- Build a provider-safe projected message array from:
  - leading system prompt and system context updates,
  - the original task or latest compacted task section,
  - all protected state summaries,
  - all pending todos,
  - last write per file,
  - last error/diagnostic,
  - a recent raw tail.
- Unlike Stage 5, do not synthesize a full replacement summary of all older
  turns. Use short deterministic boundary notes such as:

```text
[snipped-history]
Older read-only exploration was omitted from this model call.
Preserved: original task, pending todos, last errors, and recent raw turns.
```

Implementation choice:

- Phase 1 can mutate `messages` like current compaction.
- Long term, when append-oriented session logs exist, this should become a
  read-time projection only: durable history remains intact; model input is
  shaped per call.

Why third: it is cheaper and less semantically risky than summarization.

## Stage 4 — Context collapse projection

Purpose: manage very long sessions with multiple historical compact/snip
boundaries without repeatedly summarizing summaries.

Design:

- Maintain collapse metadata outside the model-visible history:
  `.deepcoder/sessions/<id>.collapse.json` or, after append-log work,
  `context_collapsed` events.
- Project older regions into stable collapse summaries at read time.
- Do not mutate the canonical event log.
- Reuse existing compact summary extraction helpers so the original task is not
  lost across repeated collapses.
- Collapse regions should be addressable for debugging: each collapse has an ID,
  source message range or event seq range, token savings, and replacement text.

This stage depends most strongly on append-oriented session storage. Before that
lands, implement only a minimal in-memory collapse map or keep Stage 4 disabled
behind a flag.

Why fourth: it solves multi-hour/multi-day sessions where repeated mutation-based
compaction creates summary-of-summary decay.

## Stage 5 — Auto compact

Purpose: last-resort semantic compression when earlier stages cannot get under
budget.

Current state:

- `buildStructuredSummary()` deterministically summarizes task, files changed,
  pending todos, and last error.

Expand:

- Keep deterministic auto-compact as the default automatic fallback.
- Add richer sections:
  - `## Goal`
  - `## Current state`
  - `## Files and evidence`
  - `## Decisions made`
  - `## Failed attempts`
  - `## Remaining work`
  - `## Next action`
- Preserve exact file paths and last error snippets.
- Optional `/compact --deep` may use a model, but automatic Stage 5 must remain
  deterministic unless explicitly configured.

Why last: it is the most lossy automatic stage.

## Configuration

Add under `config.context`:

```ts
contextPipeline: {
  enabled: boolean;              // default true after rollout
  budgetReduce: boolean;         // default true
  trident: boolean;              // default true once shipped
  snip: boolean;                 // default false during first rollout
  collapse: boolean;             // default false until append-log storage lands
  autoCompact: boolean;          // default true
}
```

Environment kill switches:

- `DEEPCODER_CONTEXT_PIPELINE=0`
- `DEEPCODER_TRIDENT=0`
- `DEEPCODER_CONTEXT_SNIP=0`
- `DEEPCODER_CONTEXT_COLLAPSE=0`

During rollout, keep current `compactIfNeeded()` behavior reachable with one
global kill switch.

## Safety invariants

Hard invariants for every stage:

1. `messages[0]` and every `role:"system"` message remain byte-identical unless
   the existing context-epoch reset path explicitly rebuilds them.
2. Provider tool-call pairing remains valid; `sanitizeForProvider()` must not
   need to drop newly orphaned calls/results.
3. Original task survives.
4. Pending todos survive.
5. Last write per file survives.
6. Last error/diagnostic survives.
7. No stage uses untrusted model/tool text as authority to delete context.
8. No stage widens permissions or affects `checkPermission()`.
9. Every reduction is traceable with a boundary/stub/collapse note.
10. Automatic stages require no live model.

## Tests

Unit:

- Stage order is fixed and reported in stats.
- Stage 1 offloads only oversized tool results and is idempotent.
- Stage 2 uses Trident invariants from its own plan.
- Stage 3 snips temporal depth while preserving protected content.
- Stage 4 projection can reconstruct a provider-safe model input from collapse
  metadata.
- Stage 5 deterministic summary includes exact file paths, last error, pending
  todos, and next action.
- Pipeline is monotonic: estimated tokens never increase.
- Pipeline is idempotent when run twice on the same messages.

Adversarial:

- Tool result claims "delete previous context" but no stage obeys it.
- Hostile `[compacted-summary]` text inside tool output does not affect boundary
  parsing.
- System/context-update messages remain untouched.
- Pairing fuzz: interleaved, missing, malformed, and duplicate tool IDs do not
  produce new provider-invalid output.
- `.deepcoder/**` managed outputs/collapse metadata are not readable through
  model tools.
- Kill switch restores legacy compaction behavior.

Integration:

- Long session with repeated large reads and later writes avoids Stage 5 because
  Stage 1 + Stage 2 get under threshold.
- Long session with unique work reaches Stage 5 and produces a useful structured
  summary.
- Resume after compaction still rebuilds current system prompt and context
  snapshot correctly.
- Fork after compaction preserves the projected model-visible state.

Gate:

- `npm run test:phase` green.

## Phasing

1. **Pipeline shell:** add `shapeContextBeforeModel()` that delegates to current
   `compactIfNeeded()` and returns stage stats. No behavior change.
2. **Stage 1 budget reducer:** lift managed-output/offload behavior into the
   pipeline and add idempotence tests.
3. **Stage 2 Trident:** implement the existing Trident plan and wire it before
   fallback summarization.
4. **Stage 5 summary upgrade:** improve deterministic summary structure without
   changing automatic model-call behavior.
5. **Stage 3 snip:** add cheap projection/trimming after Trident, initially
   default-off, then enable after adversarial coverage.
6. **Append-log dependency:** land append-oriented session storage.
7. **Stage 4 context collapse:** add read-time collapse projection backed by
   append-log event ranges.
8. **Telemetry and tuning:** report per-stage token savings in notices and
   session telemetry; tune thresholds from real sessions/flight recordings.

## Effort / risk

Large, medium-high risk because this changes the message array sent to the
provider before every model call. Keep the rollout incremental:

- First land the no-op pipeline shell.
- Keep deterministic stages only for automatic behavior.
- Preserve a legacy kill switch.
- Require adversarial tests for every stage before enabling it by default.

The highest-risk stage is context collapse because it needs clean separation
between durable history and model-visible projection. Ship it only after the
append-oriented session storage plan is complete.

## Status

**IMPLEMENTED** (orchestrator + Stages 1/2/3/5, gated green). Stage 4 (context
collapse) remains proposed — it needs the append-oriented session log for clean
read-time projection.

Implementation notes:
- New `src/context/pipeline.ts` — `shapeContextBeforeModel(messages, opts):
  ContextPipelineResult` runs Stage 1 `budgetReduce` (cap an oversized individual
  tool result, idempotent) → Stage 2 Trident + Stage 5 auto-compact (delegated to
  `compactIfNeeded`) → Stage 3 `snipTail` (cheap temporal trim of old read-only
  exploration when still over budget). Each stage is pure, monotonic, pairing-safe,
  and leaves `messages[0]`/system messages untouched.
- **With the optional stages off (default) it is byte-identical to calling
  `compactIfNeeded` directly** — proven by a parity test. So the rollout default is a
  no-op shell; `budgetReduce`/`snip` are opt-in.
- `buildMessagesForQuery` (`queryProjection.ts`) now calls the pipeline instead of
  `compactIfNeeded`; per-stage `ContextStageStats` flow into the projection's
  `stageStats` (stage names: `budget-reduce`, `trident`, `auto-compact`, `snip`).
- Config: `context.contextPipeline { budgetReduce, snip, autoCompact }` (defaults
  `false/false/true`); env kill switches `DEEPCODER_CONTEXT_PIPELINE` (forces optional
  stages off → legacy) and `DEEPCODER_CONTEXT_SNIP`. Threaded
  `AgentDeps.contextPipeline → buildMessagesForQuery → shapeContextBeforeModel`; set
  from config in `repl.ts`.
- Tests: `test/context-pipeline.test.ts` (5 unit — parity, stage order, budget-reduce
  idempotence, snip preserves last error, monotonic+idempotent) +
  `test/adversarial/context-pipeline.test.ts` (5 — injection ignored, non-summarizing
  stages don't touch system messages, zero-orphan after sanitize, monotonic on hostile
  input, kill-switch). Updated two `queryProjection` stage-name assertions.

Deferred (Stage 4 context collapse): read-time collapse projection over append-log
event ranges — depends on `feat-append-oriented-session-storage` Phases 3–4.
