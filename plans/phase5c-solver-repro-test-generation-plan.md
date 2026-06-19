# Phase 5C — Solver-side repro-test generation

## Context

The closed-loop solver (`runSolveLoop`, `src/solve/solver.ts`, Phase 5B) can only verify against a
**pre-existing, user-configured check** (`--check <name>`). For a bug report with no test, there's
nothing to solve against. Phase 6C–6F built the *measurement* of agent-authored repro tests in
local-bench (the `repro_invalid` flag: an agent test that doesn't go red→green doesn't count), and
established the safety rule that **an agent-authored test is measured but never self-grades**. But
the solver itself still cannot *generate* a repro — so the agent can't supply its own oracle.

This is the single biggest capability gap for end-to-end autonomy: today a human seeds the failing
test before every solve. Phase 5C brings repro-test generation **into the solver**: read the
task → write one failing test → validate it goes red → use it as the in-loop oracle (or as added
signal alongside a configured check) → decide whether to keep it as a regression test.

This is **not** a quality/benchmark change; it modifies the core solver. It composes with 7A
(sandbox) and 7D (isolation).

## Decisions (locked)
- **Never self-grade when an independent check exists.** If `--check` is configured, it remains the
  authority; the generated repro is an *additional* in-loop signal and a regression artifact, not the
  success oracle. When **no** check exists, the validated repro is the oracle — explicitly a weaker,
  "best-effort" verification, reported as such.
- **Validate red→green.** The generated test MUST fail on the pre-fix tree (proves it captures the
  bug). If it does not go red (passes, or errors to set up) it is `repro_invalid` → **discard + flag
  + fall back**, never block. Mirrors the local-bench `repro_invalid` semantics and the
  discard-on-invalid decision.
- **Generation is a constrained agent turn.** One turn instructed to write exactly one failing test
  at a designated path and make **no product edits**. It's just a file write — all existing gates
  (permission/approval, sensitive-path guard, sandbox) apply unchanged.
- **Treat the repro as model-authored, untrusted content.** A lightweight non-tautology guard
  (references a product symbol/path, non-empty, not `assert(true)`) flags shallow tests; never trust
  it blindly.
- **Opt-in.** `--repro auto` (default `off`). When `--check` is absent, `--repro` is the only path to
  an oracle.

## Flow (in / around `runSolveLoop`)
0. **Repro phase** (when enabled): run one constrained agent turn → write a single failing test at
   `reproPath` (default a scratch path, e.g. `.deepcoder/repro/<runId>.test.*`, or a project test dir
   if the case wants it kept).
1. **Validate red**: run the repro test on the CURRENT (buggy) tree via the existing check machinery.
   It must FAIL. If not → `repro_invalid`: discard the file, then fall back — use the configured
   `--check` if present, else return not-solved with a clear refusal ("could not generate a valid
   repro; provide `--check`").
2. **Fix loop** (existing edit→verify→retry), with verification = :
   - configured check present → the check is authority; the repro test also runs each attempt for
     signal/telemetry and must pass (it's a regression now). `solved = check passes` (and repro
     passes).
   - no configured check → the validated repro **is** the oracle. `solved = repro passes`, gated by
     the fail-to-pass proof (step 1) + the non-tautology guard. Reported as best-effort.
3. **Keep decision**: keep the repro as a regression test when it's valid (went red→green) and sits
   under an allowed/standard test path; discard a scratch-path or tautological repro. Surface
   `repro_generated / repro_valid / repro_kept / repro_path` in the result + `--telemetry`.

## Files
- **New** `src/solve/repro.ts`: `validateReproIsRed` (run the repro test, expect non-zero),
  `isTautologicalRepro` (cheap structural guard), keep/discard decision. Pure where possible.
- **Edit** `src/solve/types.ts`: `SolveOptions` gains `repro?: "auto" | "off"`, `reproPath?: string`;
  `SolveResult` gains the repro fields.
- **Edit** `src/solve/solver.ts`: run the repro phase before the fix loop; thread the repro test into
  verification; reuse `runCheck` (`src/checks/runner.ts`) to run the repro test as a transient,
  classifier-gated, sandboxed, redacted, quarantined check (no new execution surface).
- **Edit** `SolveDeps`: inject `runReproTurn?(reproPath): Promise<void>` (a constrained agent turn),
  parallel to the existing injected `runAgent` — keeps the solver core free of provider/agent details.
- **Edit** `src/agent/systemPrompt.ts`: a repro-mode instruction ("write exactly one failing test at
  <path> reproducing the issue; do not modify product code; the harness runs it").
- **Edit** `src/cli/repl.ts` / `solveRunner.ts`: provide `runReproTurn`; **edit** `src/cli/main.ts`:
  `--repro [auto|off]`; thread through `Config`.
- **Edit** `src/cli/solveRunner.ts` telemetry record: repro fields.

## Reuse
- `runCheck` + the quarantined-run store (run the repro test safely, exactly like a normal check).
- The injected-`runAgent` pattern in `SolveDeps` (mirror it for `runReproTurn`).
- The local-bench `repro_invalid` definition + non-tautology intuition (`evals/local-bench/lib/flags.ts`).
- 7A `wrapCommand` (the repro check is sandboxed for free) and 7D isolation (repro lands in the worktree).

## Safety invariants
- The repro test executes only through `runCheck` (gated/sandboxed/redacted/quarantined).
- No self-grading when an independent `--check` exists.
- The generation turn is mode-gated like any agent write; headless writes a new test file (a mutate,
  subject to the policy).
- The generated test is quality-flagged (tautology guard), never trusted blindly.

## Acceptance
**No-model:** unit tests for `validateReproIsRed` / `isTautologicalRepro`; a fake-deps integration
(inject a `runReproTurn` that writes a known failing test + a `runAgent` that applies a fix → repro
validated red, loop runs, solved, repro kept) and the invalid-repro fallback path.
**Local-bench:** a "no visible test" case where the solver must *generate* the repro (drives the
solver, not just the 6C measurement).
**Live (separate):** one case with no `--check` + `--repro auto` — does the agent produce a valid
red→green repro and fix?

## Out of scope
`--repro` default-on; multi-file/multi-test repros; cross-session repro persistence; the
reviewer-as-LLM quality gate (separate follow-up); a non-empty-patch hard requirement (separate).

## Implementation order
1. `repro.ts` pure helpers + unit tests.
2. Solver wiring: repro phase + thread into verification + `SolveResult`/telemetry fields.
3. CLI flag + systemPrompt repro instruction.
4. `repl.ts`/`solveRunner.ts` inject `runReproTurn`.
5. Local-bench no-visible-test case driving the solver.
6. (Separate decision) live smoke.
