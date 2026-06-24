# Feature — Parallel Agent Loops (Heterogeneous Role-Specialized Subagents with Context Piping)

## Honest inventory — what ALREADY exists

### 1. Multi-round coordinator loop (`src/delegate/coordinator.ts`)
`runCoordinator` already does: plan → compute runnable → `runRunnableConcurrent` →
build `RoundDigest` → coordinator model turn emits `CoordinatorDecision` (which workers
to integrate, what `nextWorkers` to append) → integrate via `applyWorker` gate chain →
repeat. Workers run in isolated worktrees. Cycle detection on new dependencies. Nested
delegation refused. This is the **scaffolding** we extend — we do NOT build a new loop.

### 2. Concurrent batch orchestration (`src/delegate/orchestrator.ts`)
`runRunnableConcurrent` runs independent workers in parallel batches via
`buildRunnableBatches` (path-scope lock conflict detection). `topoOrder` serializes
dependents after deps. Conflict detection post-run. This is the **execution engine**
we reuse verbatim.

### 3. In-process read-only subagents (`src/subagents/`)
Eight profiles: reviewer, researcher, explorer, testTriage, verifier, architect,
riskAssessor, simplifier. Each has a `role` tag for model routing, a restricted tool
registry, and produces `SubagentResult` (summary + findings + suggestedNextSteps).
Results are **explicitly advisory** — NEVER injected into parent model context
(trust-boundary isolation). Background fire-and-forget via `&research`/`&review`.

### 4. Delegate tool (`src/tools/delegateTool.ts`)
Model-callable. Spawns ONE subagent at a time (blocks). `auto: true` does the full
plan→run→validate→pr chain. Read-only path returns findings as formatted string.

### 5. Decomposer + batch command (`src/delegate/decompose.ts`, `batchPlan.ts`)
`proposeDecomposition` turns a goal into a DAG of `SubTaskSpec`. `/batch` fans them
out through `runRunnableConcurrent`. Workers are homogeneous (all write-capable,
same agent loop).

---

## The REAL gap

**No mechanism exists for one worker's structured output to feed another worker's
input context.** `WorkerTask.dependsOn` is purely a scheduling gate — "don't start B
until A finishes." But A's findings, changed files, or summary are never injected
into B's prompt. Workers are opaque black boxes to each other.

Concretely, you CANNOT express: *"Run a Researcher to explore the auth module, then
run a Developer to implement OAuth — and give the Developer the Researcher's
findings as context."* The coordinator's `RoundDigest` only carries pass/fail +
changed files + conflicts — not extracted context artifacts.

The coordinator loop already supports "round 1: spawn Research workers → integrate →
round 2: spawn Developer workers that depend on them." What's missing is the
**context pipe** between rounds: the coordinator model extracts the Research
worker's useful output and injects it into the Developer worker's prompt.

### What this feature is NOT
- NOT a new executor/spawner — `runRunnableConcurrent` is reused verbatim
- NOT a new isolation model — worktrees and the apply gate chain are unchanged
- NOT in-process subagent changes — `subagents/` profiles stay read-only and
  advisory; this feature operates at the **delegated worker** level
- NOT streaming/realtime context injection — context flows between rounds, not
  mid-execution

---

## Design

### Model: context piping between heterogeneous workers

A worker can declare `contextFrom: string[]` — worker IDs whose **resolved context
artifact** should be injected into its prompt. The coordinator, when spawning a
worker, resolves these references against completed dependency workers and
constructs an enriched prompt.

```
Round 1:  [researcher: "explore auth module"]     [researcher: "explore OAuth spec"]
               ↓ (pass)                                  ↓ (pass)
Round 2:  [developer: "implement OAuth", contextFrom: ["researcher-auth", "researcher-oauth"]]
```

The coordinator model turn between rounds 1 and 2:
1. Receives `RoundDigest` (now enriched with per-worker **context artifacts** —
   bounded summaries/extracted findings, NOT raw diffs)
2. Decides to integrate the Research workers
3. Emits `nextWorkers` that include a Developer worker with `contextFrom` pointing
   at the Research workers
4. The coordinator resolves `contextFrom` at spawn time: fetches each dependency's
   context artifact and prepends it to the Developer's prompt

### New types (additive to `src/delegate/types.ts`)

```ts
/** A bounded context artifact extracted from a completed worker, suitable for
 *  injection into a dependent worker's prompt. Redacted — no raw diffs, no
 *  secrets, bounded length (max 4000 chars). */
export interface WorkerContextArtifact {
  workerId: string;
  /** The worker's own summary of what it did/found. */
  summary: string;
  /** Structured findings suitable for downstream consumption. */
  findings: { claim: string; file?: string; line?: number }[];
  /** Files the worker changed or identified as relevant. */
  relevantFiles: string[];
  /** The source: extracted from run.json summary + self-audit. */
  extractedAt: string;
}

/** Extension to WorkerTask for context piping. */
export interface WorkerTask {
  // ... existing fields ...
  /**
   * Worker IDs whose resolved WorkerContextArtifact should be injected into
   * this worker's prompt before spawn. Each ID must be a dependency (listed in
   * dependsOn) AND must have status "passed" or "applied" with an available
   * context artifact. Violations are fail-closed (worker is skipped).
   */
  contextFrom?: string[];
}
```

### Context artifact extraction (new pure function)

A new module `src/delegate/contextPipe.ts`:

```ts
/** Extract a bounded, redacted WorkerContextArtifact from a completed worker's
 *  run.json. Returns null if the worker didn't produce extractable context
 *  (no summary, no self-audit, or empty findings). Capped at 4000 chars total. */
export async function extractContextArtifact(
  realRoot: string, planId: string, workerId: string
): Promise<WorkerContextArtifact | null>;

/** Build an enriched prompt by prepending context artifacts to the base prompt.
 *  Pure function — no I/O. */
export function enrichPrompt(
  basePrompt: string,
  artifacts: WorkerContextArtifact[]
): string;
```

`extractContextArtifact` reads the worker's `run.json` (already persisted by
`runWorker`) and its `self-audit` (if present), then builds a bounded artifact.
This is NOT a model call — it's a deterministic extraction from existing persisted
data. No live model, no secrets, no raw diffs.

`enrichPrompt` produces:

```
[Context from previous workers]
--- Context from "researcher-auth" ---
Summary: The auth module lives in src/auth/, uses JWT with HS256...
Relevant files: src/auth/middleware.ts, src/auth/tokens.ts
Key findings:
- Token validation happens in middleware.ts:42
- No refresh token mechanism exists
---

[Your task]
<original worker.prompt>
```

This is prepended — the worker's original prompt follows intact. The context is
bounded (4000 chars total across ALL artifacts) to prevent context-bloat.

### Coordinator changes (`src/delegate/coordinator.ts`)

Minimal, targeted edits:

1. **`RoundDigest` enrichment**: Add `contextArtifacts?: WorkerContextArtifact[]` so
   the coordinator model turn can SEE what context is available for downstream
   workers. This lets the coordinator make informed `nextWorkers` decisions.

2. **Pre-spawn prompt enrichment**: In the coordinator loop, before calling
   `runRunnableConcurrent`, resolve each worker's `contextFrom` references:
   - For each ID in `contextFrom`, look up the worker in the plan
   - Verify it's a dependency (in `dependsOn`) with status `passed` or `applied`
   - Call `extractContextArtifact` to get the artifact
   - Call `enrichPrompt` to build the final prompt
   - Replace `worker.prompt` with the enriched version (in a shallow copy — never
     mutate the plan's stored prompt)
   - If any `contextFrom` reference is missing or unresolvable, skip the worker
     (fail-closed)

3. **`CoordinatorDecision.nextWorkers`** can now include `contextFrom` in the
   `WorkerTask` entries it emits. The coordinator model is prompted (via the
   coordinator turn system message) to use `contextFrom` when appropriate.

### Depth guard

Existing depth guard (`delegateDepthFromEnv > 0` → refuse) is unchanged. The
context pipe operates within a single coordinator session — it does not create
nested delegation.

### Trust-boundary isolation (critical invariant)

The existing invariant: **subagent output is advisory, never authoritative. It
surfaces to the human, not to another model's context.** This is preserved for
in-process subagents (`subagents/`).

For delegated workers, context piping is DIFFERENT:
- Workers are already write-capable and trusted to produce patches (gated through
  `applyWorker`)
- The context artifact is extracted deterministically from persisted run artifacts
  — it is NOT model-generated at extraction time
- The enriched prompt is still gated through the existing `applyWorker` chain
  before any code lands
- The coordinator model (which SEES the context artifacts in `RoundDigest`) is
  the same trust level as the existing coordinator turn

In short: context piping operates on worker outputs that are already trusted for
patch production. It does not cross the in-process-subagent trust boundary.

---

## Files to change

### New files
- **`src/delegate/contextPipe.ts`** — `extractContextArtifact` + `enrichPrompt` +
  shared constant `MAX_CONTEXT_ARTIFACT_CHARS = 4000`
- **`test/delegate-context-pipe.test.ts`** — RED-first unit tests for the pure
  functions (extraction from mock run.json, prompt enrichment, boundary caps,
  empty/missing artifact handling)

### Edit files
- **`src/delegate/types.ts`** — add `WorkerContextArtifact` interface; add optional
  `contextFrom?: string[]` to `WorkerTask`; add optional `contextArtifacts?:
  WorkerContextArtifact[]` to `RoundDigest`
- **`src/delegate/coordinator.ts`** — enrich `RoundDigest` with context artifacts
  (after worker run, before coordinator turn); resolve `contextFrom` and call
  `enrichPrompt` before spawning workers; fail-closed on unresolvable references
- **`src/delegate/coordinator.ts`** (system prompt / coordinator turn prompt) —
  update the coordinator model's instructions so it knows it can emit
  `contextFrom` in `nextWorkers` and sees `contextArtifacts` in the digest
- **`test/delegate-coordinator.test.ts`** — add cases: context artifact enrichment
  flows into dependent worker prompt; unresolvable `contextFrom` → worker skipped;
  `enrichPrompt` output appears in spawned worker's prompt; context artifacts
  appear in `RoundDigest`

### Files explicitly NOT changed
- `src/delegate/orchestrator.ts` — reused verbatim
- `src/delegate/workerRunner.ts` — reused verbatim (prompt is already passed as
  CLI arg; we just pass a different string)
- `src/delegate/apply.ts` — unchanged gate chain
- `src/subagents/` — untouched; read-only subagents remain advisory-only
- `src/tools/delegateTool.ts` — untouched

---

## Tests (RED first)

### `test/delegate-context-pipe.test.ts` (pure unit, no live model, no filesystem)

1. **`extractContextArtifact` from valid run.json**: mock `fs.readFile` to return a
   `WorkerRun` with `summary` + `WorkerSelfAudit` with findings → returns a
   `WorkerContextArtifact` with summary, findings, relevantFiles
2. **`extractContextArtifact` caps at 4000 chars**: mock a huge summary → output
   is truncated with `…(truncated)` marker
3. **`extractContextArtifact` returns null for missing run.json**: file not found
   → null (not an error)
4. **`extractContextArtifact` returns null for empty summary + no audit**: worker
   produced nothing extractable → null
5. **`enrichPrompt` with one artifact**: output contains the context header,
   artifact summary, findings, and original prompt
6. **`enrichPrompt` with multiple artifacts**: all artifacts appear, each under
   its own header, in order
7. **`enrichPrompt` with null/empty artifacts array**: returns original prompt
   unchanged
8. **`enrichPrompt` respects total char cap**: multiple artifacts that would exceed
   4000 chars → later artifacts are truncated

### `test/delegate-coordinator.test.ts` (add to existing coordinator tests)

9. **Context artifacts appear in `RoundDigest`**: after a worker with a summary
   passes, `buildDigest` includes its `WorkerContextArtifact`
10. **`contextFrom` resolves and enriches prompt**: a worker with `contextFrom:
    ["dep1"]` gets an enriched prompt; assert the spawned worker command includes
    the context header text
11. **Unresolvable `contextFrom` skips the worker**: `contextFrom: ["nonexistent"]`
    → worker is skipped with reason "unresolvable contextFrom reference"
12. **`contextFrom` referencing a non-dependency is fail-closed**: worker lists a
    context source that isn't in `dependsOn` → skipped
13. **Coordinator turn receives `contextArtifacts`**: mock coordinator turn asserts
    the digest includes artifacts from passed workers

---

## Safety / invariants

1. **No new spawn path.** `runRunnableConcurrent` is called exactly as before. The
   only difference is the prompt string passed to each worker — which is already
   attacker-controlled (the coordinator model generates it).

2. **Context artifacts are bounded.** `MAX_CONTEXT_ARTIFACT_CHARS = 4000` hard cap
   prevents context-bloat. `extractContextArtifact` is a deterministic pure
   function — no model call, no secrets, no raw diffs.

3. **Fail-closed on bad references.** If `contextFrom` references a missing,
   non-dependency, or non-passed/applied worker, the dependent worker is skipped
   (not run with partial/missing context).

4. **The apply gate chain is untouched.** Context piping enriches prompts; it does
   not bypass `applyWorker` (`apply.ts:116` — 8 fail-closed gates). A worker
   that received enriched context still must pass validation, completeness,
   quality gate, and TTY confirm before its patch lands.

5. **No trust-boundary erosion for in-process subagents.** `subagents/` profiles
   remain read-only and advisory. Context piping operates exclusively on delegated
   workers, which are already write-capable and gated.

6. **Depth guard unchanged.** `delegateDepthFromEnv > 0` → coordinator refuses.
   Context piping does not create nested delegation.

7. **Redaction.** Context artifacts never contain raw diffs, secrets, or full file
   contents — only summaries + file paths + claim strings from the worker's own
   self-audit.

---

## Verification

1. `npm run typecheck` clean
2. `npm run test:phase` green WITH the new tests (zero new tests = vacuous pass)
3. Manual: `/delegate coordinate "research the auth module then add OAuth support"`
   → coordinator spawns a Research worker in round 1, extracts its findings, and
   spawns a Developer in round 2 with the Research context injected into its prompt
