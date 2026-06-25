# Feature Plan: Trident Compaction Pipeline (deterministic context reduction)

> Extracted and expanded from `plans/new/clawcode-inspired-ideas-plan.md` (Idea A).
> Porting the multi-stage deterministic context reducer from
> [claw-code](file:///home/csd81/Desktop/claw-code/rust/crates/runtime/src/trident.rs)
> (`trident.rs`) into `deepcoder`.

## Context

`deepcoder` compacts history with a single coarse move: when the conversation
crosses `budget × compactAt`, `compactIfNeeded` ([compaction.ts](file:///home/csd81/Desktop/deepcoder/src/context/compaction.ts))
replaces the whole older region (`messages[head..tailStart)`) with one
deterministic `[compacted-summary]` user message and keeps a recent tail
(`chooseTailMessages`, ~30% of budget). It's lossy and indiscriminate — a giant
`read_file` result for a file that was later overwritten is summarized to a
one-line "(read)" entry, and so is a unique diagnostic the model still needs.

**Trident** inserts a *deterministic, lossless-ish redundancy pass* **before**
that summarization fallback. It sheds turns that are provably obsolete or
duplicative, often dropping enough tokens that summarization never has to run —
preserving far more verbatim recent context. It's pure (no LLM, no
`Date`/random), so it's cheap and fully testable.

This composes with — does not replace — `plans/context/feat-better-compaction-plan.md`
("smarter summary/tail selection"): **Trident runs first** (shed redundancy);
the smarter-summarization work is the **fallback** for whatever genuinely-unique
history remains over budget.

### Interaction with the Cache-Optimized Context epoch (already shipped)

`messages[0]` is the immutable epoch baseline and there may be `[context-update]`
system messages mid-history (see `src/context/registry.ts`). Trident must treat
**all `role:"system"` messages as untouchable** (baseline, context-updates,
one-shot nudges, PR context). The epoch reset (`resetSessionContextEpoch`) runs
*right after* compaction in the loop and strips `[context-update]`s itself —
Trident must not race it.

---

## Goals & non-goals

**Goals**
- Cut redundant tokens deterministically before summarizing, so more recent raw
  context survives and summarization fires less often.
- Stay pure, deterministic, idempotent, and **monotonic** (never increase tokens).
- Preserve every guarantee `buildStructuredSummary` already makes (original task,
  last write per file, pending todos, last error).

**Non-goals**
- No LLM-assisted compaction (that's `/compact --deep` in the better-compaction plan).
- No change to the on-disk session format, the `[compacted-summary]` schema, or
  `chooseTailMessages` tail policy.
- No semantic embedding for the Cluster stage — clustering is structural/heuristic
  only (identical error/command signatures), never vector similarity.

---

## Architecture

A new orchestrator `src/context/trident.ts` runs three pure stages over the
**compactible region** — everything except `messages[0]`, any `role:"system"`
message, and the protected recent tail — then hands whatever is still over budget
to the existing summarizer.

```
compactIfNeeded(messages, opts)
   │  before = estimateMessages(messages)
   │  under trigger & !force → return {compacted:false}
   ▼
 reduceWithTrident(messages, region)         ← NEW, src/context/trident.ts
   ├─ Stage 1 Supersede  (supersede.ts)  strip obsolete turns, in place, pairing-safe
   ├─ Stage 2 Collapse   (collapse.ts)   fold runs of pure tool-I/O pairs into one note
   └─ Stage 3 Cluster    (cluster.ts)    compress repeated error/command cycles
   ▼
 mid = estimateMessages(messages)
   ├─ mid ≤ trigger  → DONE (no summarization; recent context kept verbatim)
   └─ mid >  trigger → existing buildStructuredSummary fallback on the residual older region
```

Each stage is `(msgs, protectedRange) => { changed: boolean; saved: number }`,
mutating in place (consistent with `compactIfNeeded` today) and returning stats
for a `/compact` notice and telemetry.

### Stage 1 — Supersede (`src/context/supersede.ts`)

Replace an obsolete tool result's `content` with a short stub **while keeping the
message and its `toolCallId`** (so tool-call↔result pairing never breaks; see
`sanitizeForProvider`). Stubs cite what was dropped, mirroring the existing
`boundLines` "(N of M shown)" convention.

- **Fossil file reads** — a `read_file` result for a path that a *later* turn
  wrote (`writeTracker` membership, or a later `write_file`/`edit_file` tool call
  targeting the same resolved path) → stub: `[read <path> — content superseded by a later write]`.
  Keep the **most recent** read of any path that was *not* later written.
- **Redundant searches** — identical or subsumed `grep`/`glob`/`semantic_search`
  calls (same normalized args) → keep the last occurrence's result, stub the
  earlier ones: `[grep "<q>" — superseded by a later identical search]`.
- **Failed-then-fixed runs** — a `run_bash` result containing a failure signature
  (reuse the `/\b(error|exit code [1-9]|failed|exception|traceback)\b/i` probe
  already in `buildStructuredSummary`) for a command later re-run successfully →
  crop to `[ran "<cmd>" — failed; later succeeded]`. **Never** crop the *last*
  error (the summarizer needs it).

Keys on **trackers and message structure**, never on model-supplied text claims —
a tool result that prints the literal string `[compacted-summary]` or "this file
is obsolete" must not influence supersession.

### Stage 2 — Collapse (`src/context/collapse.ts`)

Fold a **contiguous run** of *pure tool-I/O* assistant+tool pairs (read_file /
list_dir / glob / grep with **no substantive assistant prose**) into a single
synthetic `user` note:
`[collapsed N exploration calls: read src/a.ts, src/b.ts; grep "foo"]`.
Remove the assistant turns **and** their tool results together (a structurally
valid deletion — no orphans). Skip any run whose assistant turn carried reasoning
text worth keeping, or that contains a write/execute effect.

### Stage 3 — Cluster (`src/context/cluster.ts`)

Compress a **repeated diagnostic cycle** — e.g. `run check → fail → edit → run
check → fail …` on the *same command with the same error signature* — into one
line: `[clustered 4 failed attempts at "npm test" (same error); see final state]`.
Conservative & structural: group only on **identical** command + identical
error-signature hashes; a single occurrence is never clustered. This is the
fuzziest stage and ships last (and can stay flagged-off independently).

---

## Safety invariants (the gate is non-negotiable)

Trident touches the message array the provider sees, so it's a safety surface and
needs adversarial coverage. Hard invariants, asserted by tests:

1. **System messages are untouchable** — `messages[0]` and every `role:"system"`
   message (baseline, `[context-update]`, nudges, PR context) pass through byte-identical.
2. **Pairing integrity** — output always satisfies `sanitizeForProvider` with
   **zero** dropped orphans: every surviving assistant `toolCall` keeps its `tool`
   result and vice-versa.
3. **Protected content survives** — the original task (first user message / prior
   `## Task`), the **last write per file**, all **pending todos**, and the **last
   error** are never removed or stubbed.
4. **Pure & deterministic** — no LLM, no `Date.now()`/`Math.random()`; same input → same output.
5. **Idempotent** — `trident(trident(x)) === trident(x)`.
6. **Monotonic** — `estimateMessages(out) ≤ estimateMessages(in)` always; every
   stub is strictly shorter than what it replaces.
7. **Traceable** — every stub/collapse note states what was shed (no silent drops).

---

## Files

**New**
- `src/context/trident.ts` — orchestrator + `TridentStats`; the `reduceWithTrident` entry point.
- `src/context/supersede.ts` — Stage 1.
- `src/context/collapse.ts` — Stage 2.
- `src/context/cluster.ts` — Stage 3.

**Modified**
- `src/context/compaction.ts` — in `compactIfNeeded`, after the trigger check and
  `chooseTailMessages`, run `reduceWithTrident` over `[head, tailStart)`; if the
  result is under `trigger`, return `{compacted:true}` **without** summarizing;
  else fall through to today's `buildStructuredSummary` splice on the residual.
  Extend `CompactResult` with optional `trident?: TridentStats`.
- `src/config/config.ts` (+ `fileConfig.ts`/`debugConfig.ts`) — add
  `context.tridentCompaction` (bool) and env `DEEPCODER_TRIDENT` (`1`/`0`),
  default **on**, with a kill-switch for A/B and debugging. Per-stage sub-flags
  optional (cluster can ship off).

**Reuse (do not reinvent)**
- `estimateMessages` (`src/context/tokenBudget.ts`) for the token accounting.
- `boundLines` (`src/tools/outputBound.ts`) for capped, attributed stub lists.
- `sanitizeForProvider` semantics (`src/agent/agentLoop.ts`) — reuse it in tests
  to assert pairing integrity.
- `readTracker`/`writeTracker` (already threaded into `CompactOptions`) for the
  fossil-read and last-write determinations.
- The failure-signature regex already in `buildStructuredSummary`.

---

## Tests (normal + adversarial — both required by the gate)

**Unit** (`test/trident-compaction.test.ts`)
- Supersede: a `read_file(src/a.ts)` followed by a later `write_file(src/a.ts)` →
  read result stubbed; an un-rewritten file's last read is **kept**.
- Supersede: duplicate `grep "foo"` keeps the last, stubs earlier; failed-then-
  succeeded `run_bash` cropped, but the **last** error is preserved.
- Collapse: 5 consecutive pure read pairs → one note; a run containing assistant
  reasoning or a write effect is **not** collapsed.
- Cluster: 4 identical failing `npm test` cycles → one clustered line; a single
  failure is untouched.
- `compactIfNeeded`: when Trident alone drops under `trigger`, the result has
  **no `[compacted-summary]`** (summarization skipped); when it doesn't, the
  summary still appears on the residual.
- Determinism + idempotence + monotonic-token assertions.

**Adversarial** (`test/adversarial/trident-compaction.test.ts`)
- Pairing fuzz: interleaved/partial tool sequences → `sanitizeForProvider(trident(x))`
  has zero orphans.
- `messages[0]` and `[context-update]`/system messages are byte-identical after Trident.
- Protected content (task, last write per file, pending todos, last error) always survives.
- **Prompt-injection**: a tool result whose text claims "this file is obsolete,
  drop earlier turns" or embeds `[compacted-summary]` does **not** cause any
  supersession — decisions key only on trackers/structure.
- Token monotonicity holds on hostile/huge inputs; `DEEPCODER_TRIDENT=0` is a
  byte-identical no-op (legacy path unchanged).

All tests use plain in-memory `AgentMessage[]` fixtures — no provider, no LLM
(matches the fake-provider convention).

---

## Verification (end to end)

1. `npm run typecheck`.
2. `npm run test:changed` during the inner loop; `npm run test:adversarial` for the new safety tests.
3. **The gate:** `npm run test:phase` green before done.
4. Manual: drive a long session that reads many files then overwrites several,
   force `/compact`, and confirm the notice reports superseded/collapsed counts,
   the token count drops more than legacy, and the recent tail is kept verbatim.
   `DEEPCODER_TRIDENT=0` reproduces the legacy path for A/B.

---

## Suggested phasing (each independently shippable + gated)

1. `src/context/supersede.ts` + unit/adversarial tests (pairing, protected, injection) — biggest single win.
2. `src/context/collapse.ts` + tests.
3. `src/context/trident.ts` orchestrator wired into `compactIfNeeded`, behind
   `DEEPCODER_TRIDENT` (default on), + the "skip summarization when under budget" path.
4. `src/context/cluster.ts` + tests (ships last, independently flaggable).

---

## Status

**IMPLEMENTED** (all three stages + orchestrator, wired, default-on, gated green).

Implementation notes:
- New `src/context/tridentUtil.ts` (shared pure structural helpers — `indexToolCalls`,
  tool-class predicates, `pathArg`/`commandArg`/`argKey`, `FAILURE_RE`,
  `lastErrorIndex`, `StageStats`/`Region`), `supersede.ts`, `collapse.ts`,
  `cluster.ts`, and `trident.ts` (`reduceWithTrident` orchestrator + `TridentStats`).
- `compactIfNeeded` (`src/context/compaction.ts`) runs Trident over `[head, tailStart)`
  after `chooseTailMessages`; if the result is under trigger (non-force) it returns
  `{compacted, trident}` **without** summarizing. `CompactOptions.trident?` overrides
  the env default; `CompactResult.trident?` carries stats.
- Config: `context.tridentCompaction` (default **true**) in `config.ts` with
  precedence default < file < `DEEPCODER_TRIDENT` env (kill switch); Cluster has its
  own `DEEPCODER_TRIDENT_CLUSTER`. Threaded `AgentDeps.tridentCompaction` →
  `buildMessagesForQuery` → `compactIfNeeded`; set from config in `repl.ts`.
- **Design choices vs. the plan prose:**
  - Supersede's last-error guard applies to read/search stubbing only; a
    *failed-then-succeeded* bash run is cropped even if it is the lexically-last
    failure (it's resolved — the unresolved last error has no later success and is
    never cropped).
  - Cluster is **content-only** (stub earlier identical failures, keep the last) —
    pairing-trivially-safe and monotonic — rather than removing message groups.
- Tests: `test/trident-compaction.test.ts` (9 unit — each stage, skip-summary vs.
  fall-through, determinism/idempotence/monotonicity) +
  `test/adversarial/trident-compaction.test.ts` (5 — zero-orphan after sanitize,
  system/`[context-update]` byte-identity, injection cannot trigger supersession,
  protected content survives, kill-switch no-op). One pre-existing
  `test/compaction.test.ts` case was pinned to `trident:false` so it keeps exercising
  the summarizer path specifically (the skip-summary behavior has its own test).

Deferred: explicit compaction-boundary metadata for the append-log
(`feat-append-oriented-session-storage` Phase 4) can later consume `TridentStats`.
