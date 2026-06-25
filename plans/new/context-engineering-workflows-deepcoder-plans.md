# Context Engineering Workflows for DeepCoder

## Source Workflows Analyzed

This plan maps the copied Claude context-engineering files in `/home/csd81/Desktop/context_engineering/src` onto DeepCoder's current architecture.

Claude-side workflow files:

- `query.ts`: central pre-model pipeline and recovery loop.
- `context.ts`, `utils/api.ts`, `utils/claudemd.ts`: system/user context assembly and instruction loading.
- `services/compact/autoCompact.ts`, `compact.ts`, `microCompact.ts`: thresholding, summarization, and lightweight compaction.
- `utils/toolResultStorage.ts`: per-message tool-result budget and resume reconstruction.
- `utils/toolSearch.ts`, `tools/ToolSearchTool/*`: deferred tool schema workflow.
- `utils/sessionStorage.ts`, `utils/sessionRestore.ts`: append-oriented reconstruction and metadata recovery.
- `utils/tokens.ts`, `services/tokenEstimation.ts`, `utils/contextAnalysis.ts`, `query/tokenBudget.ts`: estimation, accounting, and diagnostics.

DeepCoder already has several corresponding seams:

- `src/agent/agentLoop.ts`: `runAgentLoop`, `withEphemeralContext`, provider call, tool dispatch.
- `src/context/compaction.ts`: single deterministic `compactIfNeeded` path.
- `src/context/registry.ts`: cache-optimized `[context-update]` reconciliation.
- `src/session/sessionStore.ts`: atomic JSON snapshot persistence.
- `src/session/flightRecorder.ts`: exact model-call capture for replay/debugging.
- `src/runtime/sessionFactory.ts`: session creation/resume, context snapshots, tool registry assembly.

## Workflow 1: Layered Pre-Model Context Shaping

Current DeepCoder has one main automatic compaction path: `compactIfNeeded()` mutates `messages` in place when estimated tokens exceed `compactAt * contextBudgetTokens`. It also injects ephemeral todos, JIT instructions, delegation hints, and playbook context at send time.

Claude's copied workflow splits this into a staged `messagesForQuery` projection:

1. derive messages after compact boundary,
2. apply per-tool-result budget,
3. snip old low-value turns,
4. microcompact old tool results,
5. project context collapse,
6. auto-compact only as last resort.

### Plan

Introduce a `src/context/shapers/` pipeline and route every model call through it before `getResponse()`.

Implementation slices:

- Add `ContextShaper` interface:
  - input: persisted `messages`, `ToolContext`, budget config, runtime flags.
  - output: `messagesForQuery`, optional persisted events, optional notices.
- Move current `compactIfNeeded()` behind a final `autoCompactShaper`.
- Add cheaper shapers before it:
  - `toolResultBudgetShaper`: replace oversized historical tool messages with managed-output references.
  - `microcompactShaper`: clear older read/search/bash outputs after a recency threshold while keeping recent working context.
  - `contextUpdateShaper`: keep existing `reconcileContext()` behavior as a formal stage.
  - `ephemeralContextShaper`: replace `withEphemeralContext()` with a named final injection stage.
- Keep stored history separate from `messagesForQuery`; only stages that intentionally persist should mutate or append records.

Acceptance:

- Existing compaction tests still pass.
- A unit test proves cheap shapers run before deterministic compaction.
- A large tool result is offloaded/referenced without forcing full compaction.
- `sanitizeForProvider()` still prevents orphan tool-call/tool-result pairs after shaping.

Related existing plan: `feat-five-stage-context-pipeline-plan.md`.

## Workflow 2: Tool Result Budget With Read-Time Reconstruction

DeepCoder currently caps tool results before appending them to history and optionally writes the full output to managed output storage. That prevents individual results from flooding the context, but the original message history does not preserve a separate reconstruction map for stable read-time projection.

Claude's copied workflow separates:

- full transcript record,
- replacement record,
- projected content sent to the model,
- reconstruction of replacement state on resume.

### Plan

Promote DeepCoder's current truncation/offload into a persisted replacement workflow.

Implementation slices:

- Add `ContentReplacementRecord` to session persistence:
  - message id or tool call id,
  - tool name,
  - managed output id/path,
  - replacement text,
  - original byte/token estimate,
  - created-at turn index.
- Add stable message ids if needed; tool call ids alone are enough for tool messages, but user/assistant summaries may need ids later.
- Update `pushToolResult()` path in `agentLoop.ts` to persist a replacement record when output is offloaded.
- Add a read-time projector that applies replacement records to full stored history before provider send.
- On resume, reconstruct the replacement map and avoid re-deciding which historical outputs to replace.

Acceptance:

- Resume does not re-expand old huge outputs.
- Managed output remains readable through `read_managed_output`.
- Replacement decisions are deterministic across resume/fork.
- Full transcript/search/export can still explain where content was offloaded.

Related existing plans: `feat-append-oriented-session-storage-plan.md`, `feat-messages-for-query-context-shapers-plan.md`.

## Workflow 3: Deferred Tool Schemas

DeepCoder currently sends `deps.registry.schemas()` on each provider request. This is simple and reliable, but every native/MCP/plugin tool schema competes with conversation context.

Claude's copied workflow advertises some tools by name/description and lets a `ToolSearch` tool return full schemas only when needed.

### Plan

Implement deferred schema exposure behind a config flag and an auto threshold.

Implementation slices:

- Add tool metadata:
  - `alwaysLoad?: boolean`
  - `deferLoading?: boolean`
  - `schemaWeightEstimate?: number`
  - `keywords?: string[]`
- Add a `tool_search` session tool that returns full schemas for selected deferred tools.
- Change registry schema compilation:
  - always include critical tools: read/search/edit/bash/todo/tool_search/delegate.
  - defer MCP, plugin, low-frequency, or large schemas.
  - enable automatically when schema token estimate exceeds a threshold.
- Add a persisted or ephemeral `[deferred-tools]` context block listing deferred names and one-line descriptions.
- Ensure permission filtering still happens before both visible and deferred tools are exposed.

Acceptance:

- Provider request schema count drops when deferred mode is active.
- Model can select a deferred tool by calling `tool_search`.
- Denied tools never appear in deferred listings.
- Flight recorder captures both the reduced schema request and subsequent loaded schema request.

Related existing plan: `feat-deferred-tool-schemas-plan.md`.

## Workflow 4: Streaming Tool Execution

DeepCoder streams assistant text and collects `tool_call_complete` events in `consumeStream()`, but executes tools only after the provider response finishes, serially in `runAgentLoop()`.

Claude's copied workflow can begin executing tools as soon as tool calls stream in, then emits results in original order.

### Plan

Add a streaming tool executor without changing the provider contract for non-streaming models.

Implementation slices:

- Extend provider event model if needed to expose complete tool calls as soon as arguments are complete.
- Add `StreamingToolExecutor` service:
  - starts read-only/session tools immediately,
  - serializes mutate/execute tools,
  - preserves output order by tool call index,
  - aborts sibling long-running executions on fatal bash/execute failure where appropriate.
- Gate with config, default off initially.
- Keep current serial path as fallback.
- Integrate permission checks before execution starts.

Acceptance:

- Multiple read-only tool calls can run concurrently.
- Mutating tools do not overlap.
- Tool results are appended in provider order.
- Abort stops pending and in-flight tools cleanly.

Related existing plan: `feat-streaming-tool-executor-plan.md`.

## Workflow 5: Context Overflow Recovery

DeepCoder has proactive compaction and retry handling for provider errors, but prompt-too-long recovery is not yet a first-class layered workflow. Claude's copied `query.ts` tries recovery paths after real API overflow: collapse drain, reactive compact, media stripping, then final prompt-too-long termination.

### Plan

Add reactive overflow recovery around provider calls.

Implementation slices:

- Introduce an explicit `ContextOverflowError` classifier in provider retry handling.
- On overflow:
  - do not append the failed model response as assistant content,
  - run a reactive compaction pass over `messagesForQuery`,
  - retry once with the compacted projection,
  - persist a compact boundary only if recovery succeeds.
- For media/large-output errors, strip or replace expensive blocks first, then compact.
- Add a per-turn recovery guard to prevent infinite compact/retry loops.

Acceptance:

- A fake provider that throws prompt-too-long once succeeds after reactive compact.
- A fake provider that keeps throwing exits with a clear notice.
- Recovery does not duplicate assistant text or corrupt tool-call pairing.

Related existing plan: `feat-reactive-context-overflow-recovery-plan.md`.

## Workflow 6: Append-Oriented Session Storage

DeepCoder stores sessions as atomic JSON snapshots in `.deepcoder/sessions/<id>.json`. This is simple, but every save rewrites the session and makes read-time reconstruction harder.

Claude's copied workflow records append-only JSONL entries and reconstructs live state on read.

### Plan

Layer append-oriented events under the existing snapshot store first, then migrate resume to event replay.

Implementation slices:

- Add `.deepcoder/sessions/<id>.jsonl`.
- Define event types:
  - `message_appended`
  - `todo_replaced`
  - `context_snapshot_updated`
  - `content_replacement_recorded`
  - `compact_boundary`
  - `metadata_updated`
- Write append events alongside current snapshot saves.
- Add replay loader that reconstructs `PersistedSession`.
- Switch resume to prefer JSONL when present, fallback to JSON snapshot.
- Keep snapshot as periodic checkpoint until JSONL replay is proven.

Acceptance:

- Snapshot and replay produce equivalent session state in tests.
- A partially written final JSONL line is ignored safely.
- Fork/resume do not restore session-scoped approvals beyond current config.

Related existing plan: `feat-append-oriented-session-storage-plan.md`.

## Workflow 7: Instruction Hierarchy and Lazy Path Context

DeepCoder already supports project instructions and JIT path-local instructions through `jitContext()`. Claude's copied `claudemd.ts` has a richer hierarchy, include handling, path frontmatter, lazy child rules, and instruction-loaded hooks.

### Plan

Extend DeepCoder's instruction graph rather than replacing it.

Implementation slices:

- Support hierarchy:
  - managed/global,
  - user,
  - workspace,
  - local/private,
  - directory/path-scoped rules.
- Preserve existing `AGENTS.md`, `CLAUDE.md`, `.deepcoder/instructions.md` compatibility.
- Add `@include` with text-file allowlist and cycle detection.
- Keep JIT path rules injected once as ephemeral context, but record which source files became active for audit.
- Add `/instructions show` visibility for loaded and pending lazy rules.

Acceptance:

- Nested rule file loads only after a matching path is read.
- Includes cannot escape safety allowlist or cycle infinitely.
- Existing AGENTS.md behavior remains compatible.

Related existing plans: `feat-instruction-hierarchy-tiers-plan.md`, `feat-guidance-vs-enforcement-context-plan.md`.

## Workflow 8: Context Observability

Claude's copied files include token estimation, context analysis, compact warnings, and exact prompt dumping hooks. DeepCoder has a flight recorder, but user-facing context breakdown can become more actionable.

### Plan

Add a context report command and model-call breakdown.

Implementation slices:

- Add `/context report` or extend existing context command.
- Show:
  - system baseline estimate,
  - dynamic context updates,
  - conversation history,
  - tool results,
  - ephemeral todos/JIT/playbook,
  - tool schemas,
  - deferred tools saved tokens,
  - managed-output replacements.
- Use flight recorder manifests to inspect exact sent payloads when enabled.

Acceptance:

- Report works without live model.
- Report explains why compaction/deferred tools triggered.
- Sensitive managed outputs are summarized, not dumped.

## Recommended Build Order

1. Context shaper pipeline abstraction.
2. Tool result replacement records and read-time projection.
3. Append JSONL session events for messages/replacements/compact boundaries.
4. Reactive overflow recovery.
5. Deferred tool schemas.
6. Streaming tool executor.
7. Richer instruction hierarchy and lazy rules.
8. Context observability command.

The first three should land before the more ambitious features. They create the stable distinction DeepCoder currently lacks: persisted session history versus provider-facing `messagesForQuery`.

