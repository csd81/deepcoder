# Phase 9M — Manifest Coverage Gate (force self-authored failing tests for every deliverable)

## Problem

Delegated workers stop the moment `--check phase` goes green. When the principal seeds
only a thin red surface (or none), the worker implements exactly to that surface and stops —
"delivery scope == seed scope". Prose in the task packet ("write all 12 tests, add config,
add slash") is not a gate, so workers reliably return **partial** work.

10H demonstrated it twice: first a literal no-op (check already green), then 362 lines of
*good* planner code that greened the 2 seeded tests and stopped — no config, no slash, 2/12 tests.

## Goal

Force a worker to **author a failing test for every deliverable before it may implement
anything**, and make applyability depend on that coverage — enforced in code, not prose.
The principal supplies a *deliverable manifest* (a checklist of ids + acceptance text — the
spec, NOT test code). The worker writes the red tests itself.

## Mechanism — generalize 9L `runWorkerTdd` into a manifest-gated two-phase run

1. **Phase A — author-all-red.** Worker writes ONLY test files, tagging each test title with
   `[<deliverable-id>]`. No production edits (existing repro-phase patch validation enforces
   tests-only).
2. **Coverage + red gate (NEW).** Run the configured `testCommand` (config-derived, classifier-
   gated via `runCheck`) on the baseline+repro worktree, capture TAP, and prove:
   - every manifest deliverable has ≥1 tagged test (no `uncoveredDeliverables`), AND
   - every tagged test **fails on the clean baseline** (`not ok`) — a tagged test that passes
     on baseline is vacuous/self-grading → `nonRedDeliverables` → reject (`red_failed`).
3. **Phase B — implement-to-green.** Worker writes production code; the Phase-A test files are
   locked against weakening (existing fix-phase forbids weakening repro). Re-run the probe on the
   fixed worktree: every previously-red tagged test must now pass.
4. **Apply gate.** `status === "green_confirmed"` is emitted ONLY when greenConfirmed AND
   `coverageComplete`. The 9K `requireValidatedTest` gate already ties applyability to
   `green_confirmed`; add a defensive explicit `coverageComplete` check there too. A worker that
   authors 2 tests, greens them, and stops now **fails coverage** instead of looking done.

## Honest limitation
This forces *breadth* (one red test per deliverable) and *non-self-grading* (red on baseline).
It does NOT machine-verify each test is semantically deep (no oracle) — a worker could write a
shallow-but-red test per deliverable. Thin tests are flagged in principal review, not by the gate.

## Files
- **NEW** `src/delegate/coverage.ts` (pure): `parseTapResults(tap)`, `computeCoverage(deliverables, results)`.
- **Edit** `src/delegate/types.ts`: `WorkerDeliverableSpec`; `WorkerTddRequirement.{deliverables,testCommand}`;
  `WorkerTddRun.{coverage,coverageComplete,uncoveredDeliverables,nonRedDeliverables}`.
- **Edit** `src/delegate/tdd.ts`: manifest branch — injectable `runCoverageProbe` seam (default:
  ephemeral `runCheck` + read log → TAP), red coverage proof, green coverage proof, populate record.
- **Edit** `src/delegate/tddPrompts.ts`: manifest-aware repro prompt (enumerate deliverables + the
  `[id]` tag rule) and fix prompt (make ALL authored tests green; weaken none).
- **Edit** `src/delegate/validation.ts`: `requireValidatedTest` also requires `coverageComplete` when
  the worker's tdd declared deliverables.
- **Edit** `src/cli/slashCommands.ts`: `/delegate run --tdd --manifest <file.json>` loads the manifest.
- **NEW** `test/adversarial/delegate-coverage.test.ts` (pure) + extend `delegate-tdd.test.ts`
  (orchestration: manifest red→green applyable; coverage-gap → red_failed; vacuous-green tagged test
  → nonRed → red_failed; no-weaken; apply refused without coverageComplete).

## Reuse (do not reinvent)
- 9L `runWorkerTdd` worktree/red/green machinery; `validatePatch`; `runCheck` (classifier+bounds+log);
  the injected `spawnWorker` seam; the 9K `validateWorkerResult` apply gate.

## Acceptance (no live model)
- `npm run typecheck` && `npm run test:phase` green incl. all pre-existing tests.
- New adversarial tests pass. Then dogfood: re-delegate 10H through `--tdd --manifest` with the 12
  deliverables and confirm the gate forces all 12 red→green (or honestly report what it forced).
