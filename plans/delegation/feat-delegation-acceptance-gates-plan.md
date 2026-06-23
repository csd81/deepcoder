# Feature — Encode delegation lessons as automated acceptance gates

## STATUS — 2026-06-23 (implemented via 3 Claude subagents + in-house Workstream C)

- **Workstream A — Reachability gate: DONE.** `orphaned_deliverable` failure in
  `completeness.ts`; wired through `validateWorkerResult` (Gate 4) with a real
  `buildFindImporters(root)` in `validation.ts` reusing `src/index/imports.ts`.
  Anchor test proves it fires end-to-end (`test/adversarial/delegate-reachability-wiring.test.ts`).
- **Workstream B — Default test-delta gate: DONE.** `deliverable_untested` failure;
  scoped by per-symbol `mustBeTested` or input `requireDeliverableTested`; downgrades
  to a warning when `expectedTests`/`tdd` already own coverage. Unit tests in
  `test/delegate-acceptance-gates.test.ts`.
- **Workstream C — Verify-first default: DONE (scoped).** `DEFAULT_ACCEPTANCE_FIRST.enabled`
  flipped to `true` (`/delegate plan` is acceptance-first by default → `requireProductionChange`).
  Did NOT force `requireDeliverableTested` globally (modest value, real blast radius) — gate B
  stays opt-in via `mustBeTested`.
- Full gate green: typecheck clean, unit 511, adversarial 1890.

### Follow-up (NOT done — deliberate)

The heuristic `planner.ts` emits coarse workers (title/allowedPaths + tdd) — it does
NOT emit per-symbol `expectedSymbols` or deliverable-module paths. So gates A/B are
**available + wired** but only activate when a task packet declares
`expectedReachable`/`mustBeTested`. Auto-populating those from the planner (so every
acceptance-first plan gets reachability + test-delta automatically) requires the
planner to infer deliverable modules/symbols — a separate, larger slice. Forcing the
gates without that metadata would be inert, so it was intentionally left out.

## Context

deepcoder already has a **mature** worker-acceptance pipeline:
`validation.ts` (`validateWorkerResult`, an 8–9 gate pure pipeline) →
`completeness.ts` (`evaluateCompleteness`: deliverables, expected files/symbols/
tests, self-audit cross-check, production-change gate) → `loadAndValidateWorker`
(the loader that injects filesystem truth). The solve loop already re-feeds a
**compact** failure summary (`summarizeCheckFailure`, not the raw log) and caps
attempts at 3 by default.

So the hard-won delegation lessons are *partly* encoded already. This plan closes
the three that are NOT, and that cause the worst real failures — silently merging
work that is inert or untested.

### Lessons already satisfied (do NOT rebuild — just confirm during impl)

- **Compact-failure re-feed + attempt cap ≤3** (lesson #3): `solver.ts:288-306`
  summarizes via `summarizeCheckFailure`; `config.solveMaxAttempts` default 3.
- **Containment flags**: `delegate.sh` already passes `--no-contain --sandbox off`
  (and `--no-contain` is now honored after the 2026-06-23 fix).
- **`qualityGate.ts` / `selfAudit.ts` orphans**: these files do NOT exist; the logic
  is embedded in `validation.ts` Gate 6 and `completeness.ts` §5. The earlier
  "orphan to wire/delete" audit was stale. Nothing to do.

### The three real gaps (this plan)

| Lesson | Gap today | Gate to add |
|---|---|---|
| #1 Green-but-inert / orphaned | `completeness` proves a file *exists* and a symbol is *added*, but never that the module is **imported / reachable** from a runtime entrypoint | **Reachability gate** (Workstream A) |
| #2 Vacuous tests | Anti-vacuous is **opt-in** (needs `expectedTests` / `tdd` manifest / `requireValidatedTest`); a packet without them passes with zero new tests | **Default test-delta gate** (Workstream B) |
| #8 Verify-then-force | `AcceptanceFirstOptions.enabled` defaults **OFF**; verify-then-force is not the default acceptance posture | **Default-on verify-then-force** (Workstream C) |

## Workstream A — Reachability / orphan gate (lesson #1, highest value)

**Goal:** fail acceptance when a deliverable module is defined + tested but never
wired into the runtime (the single most common weak-model failure).

- **Types** (`src/delegate/types.ts`): add an `expectedFiles` mode
  `"must_be_reachable"` OR a dedicated `task.reachability?: { module: string;
  fromEntrypoint?: string }[]`. Decide in impl — prefer a new
  `expectedReachable` array so existing `expectedFiles` semantics are untouched.
  Add failure code `orphaned_deliverable`.
- **Pure gate** (`src/delegate/completeness.ts`): new section that, for each
  reachability rule, checks whether **any non-test source file** imports the
  module. Mirror the existing injection pattern: take an injected
  `findImporters?: (modulePath: string) => string[]` (the importers among the
  post-patch tree). Fail closed when the predicate is absent (same as
  `fileExists`). Failure `orphaned_deliverable` when the importer set is empty or
  contains only test files.
- **Loader wiring** (`src/delegate/validation.ts` / `loadAndValidateWorker`):
  build `findImporters` from the worktree — a deterministic scan of non-test
  `.ts` files for an `import ... from "<resolved module>"` specifier (reuse the
  module-resolution + `classify()` test/non-test split already imported in
  `completeness.ts`). No full type-graph needed; a specifier scan catches inert
  modules cheaply.
- **Dogfood:** the reachability gate we add MUST itself be reachable — its wiring
  into `validateWorkerResult` is part of the same change, and an anchor test
  asserts `validateWorkerResult` invokes it.

## Workstream B — Default anti-vacuous test-delta gate (lesson #2)

**Goal:** without requiring a pre-declared manifest, reject a patch whose
deliverable symbols are not exercised by a new/changed **test** assertion.

- **Derive from `expectedSymbols`** (already in the packet): for each expected
  symbol, require its name to appear on an **added line inside a test file**
  (reuse `addedLinesForFile` + `classify().kind === "test"`). Gate is active when
  a new config flag `requireDeliverableTested` (default ON under acceptance-first)
  is set, or when the symbol rule opts in (`es.mustBeTested`). Failure code
  `deliverable_untested`.
- This is the manifest-free complement to the existing 9M/9L manifest coverage —
  it raises the floor for *every* delegation, not just TDD-manifest ones.
- Keep it a **warning, not a failure**, when the task explicitly declares
  `expectedTests`/`tdd` (those stronger gates already own the check) to avoid
  double-failing.

## Workstream C — Verify-then-force as the default posture (lesson #8)

**Goal:** make acceptance-first the default so verify runs first and forcing only
escalates on failure.

- **Config** (`src/config/config.ts`): flip `delegate.acceptanceFirst.enabled`
  default to **true** (keep an env/file override to disable). Confirm the
  autopilot path (`DelegateAutopilotConfig.acceptanceFirst` already default true)
  and the single-run apply path both consult it.
- **No behavior change to forcing mechanics** — only the default posture. Add a
  test asserting the resolved default is `enabled: true` and that an explicit
  `false` override still wins.

## Files to change

- `src/delegate/types.ts` — new task fields (`expectedReachable` and/or symbol
  `mustBeTested`), new failure codes.
- `src/delegate/completeness.ts` — reachability gate + test-delta gate (pure).
- `src/delegate/validation.ts` — wire both gates into `validateWorkerResult`;
  build `findImporters` in `loadAndValidateWorker`.
- `src/config/config.ts` — `acceptanceFirst.enabled` default → true.
- Tests: `test/delegate-completeness.test.ts` (extend), new
  `test/adversarial/delegate-reachability.test.ts`,
  `test/adversarial/delegate-test-delta.test.ts`, `test/containment-*`-style
  config test for the default flip.

## Execution — in-house, my own Claude subagents (NOT DeepSeek workers)

A and B both edit `completeness.ts` + `types.ts`, so parallel edits would
conflict. Sequence to keep ownership disjoint:

1. **Subagent 1 — types** (`types.ts` only): add fields + failure codes. Small,
   foundational, no logic.
2. **Subagent 2 — gates** (`completeness.ts` only, after 1): implement both pure
   gates **TDD, red-first**, with unit tests. Owns `completeness.ts` + its test.
3. **Subagent 3 — wiring** (`validation.ts` only, after 2): invoke the gates in
   `validateWorkerResult`, build `findImporters` in `loadAndValidateWorker`,
   anchor tests proving the gates actually run (no orphan).
4. **Subagent 4 — config** (`config.ts` only): default flip + test.

I integrate after each, run the **full `test:phase`** (unit + adversarial)
between stages, and personally verify the wiring (the reachability gate must be
reachable — dogfood). Red-first, non-vacuous tests enforced (the very lessons
this plan encodes apply to building it).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green (unit + adversarial).
2. New adversarial tests prove, against synthetic patches:
   - an orphaned module (defined + tested, never imported) → `orphaned_deliverable`
     failure; the same module with one non-test importer → pass.
   - a deliverable symbol with no test reference → `deliverable_untested`; with a
     test reference → pass; suppressed to warning when `expectedTests` present.
   - `acceptanceFirst.enabled` resolves true by default; explicit false wins.
3. Anchor test: `validateWorkerResult` invokes both new gates (proves wired).

## Out of scope (deliberate, deferred)

- **Self-delegation ergonomics** (model-callable worker tool, complexity router
  simple→flash/complex→in-house, ActivityRegistry completion notices for detached
  workers) — a separate plan; this one is acceptance-gates only.
- Full type-aware import-graph reachability (a specifier scan is enough to catch
  inert modules; a real graph is a later refinement).
- Executing `mustGoRedOnBaseline` in-process (still verified out-of-band).
