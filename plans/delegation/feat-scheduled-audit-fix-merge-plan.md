# Feature — Self-maintenance loop: audit → fix → merge

## Context

Three independently-landable features, when composed, form a hands-off
self-maintenance loop for the repo:

| Phase | Primitive | Plan |
|---|---|---|
| Audit | fan-out subagents, per-area findings, synthesis doc | `feat-repo-audit-v2-plan.md` |
| Fix | `delegate auto "<task>"` — worktree-first, worker-self-seeded TDD, PR gated on 9 gates | `feat-autonomous-delegate-to-pr-plan.md` |
| Merge | `delegate merge` — check gate, resolve conflicts, re-gate, `gh pr merge` | `feat-autonomous-pr-merge-plan.md` |

**Gap:** nothing chains them. A human runs the audit, reads the findings doc,
hand-writes a task per finding, fires `delegate auto` per task, then `delegate merge`
per PR — every cycle. The audit plan explicitly calls this out ("each area is an
independent, parallelizable unit — a good fit for delegation / PR per area") but
stops at the design level.

**Goal:** one command — `deepcoder audit sweep` — that runs the whole loop:
audit → parse HIGH/MED findings → `delegate auto` per finding → `delegate merge --all-delegated`
→ report. Hands-off, restartable, **never merges a red gate**.

## Design

### The chain

`deepcoder audit sweep [--tracks A,B,C,D] [--no-fix] [--no-merge] [--dry-run] [--json]`:

1. **Audit** — fan out read-only subagents per track (reuse `delegate` tool, profile
   `researcher`). Each produces `plans/audit/audit-<area>.md` with findings as
   `file:line · severity · claim`. A synthesis step merges them into a single
   prioritized findings list.

2. **Triage** — parse the synthesis doc for HIGH/MED findings. Convert each to a
   discrete task: `"Fix <severity> finding: <claim> at <file:line>. TDD required."`
   LOW findings are recorded but not auto-fixed.

3. **Fix** — for each HIGH/MED task, call `runDelegateAuto(task, { tdd: true })`.
   Each runs in its own worktree, worker self-seeds a red test, implements, gates
   verify (including red→green proof), and a PR opens **iff** `applyable`.
   Non-applyable workers → PR skipped, failing gate codes recorded.
   `--no-fix` stops after triage (report-only mode).

4. **Merge** — `runDelegateMerge({ allDelegated: true })` over every open delegated
   PR from this sweep. Each PR is re-gated immediately before merge; conflicts are
   resolved via the existing `/resolve` flow (reusing `mergeConflict.ts`), then
   re-gated. A resolution that regresses the gate is **not** merged.
   `--no-merge` stops after fix (PRs open, merge stays human).

5. **Report** — JSON summary: findings found, tasks created, PRs opened, PRs merged,
   skipped + why, unresolved files.

### Trigger / scheduling

No cron daemon lives in the repo. Instead, the sweep is a **single CLI entrypoint**
that can be invoked from outside by anything that can run a command:

- **Manual:** `deepcoder audit sweep`
- **Hook-driven:** attach to `SessionStart` or `PostCheck` via the hooks system
  (`src/hooks/types.ts` — run a script that invokes `deepcoder audit sweep`).
- **External scheduler:** a systemd timer, cron job, or CI schedule that runs
  `deepcoder audit sweep` on a cadence.

The sweep itself is the trigger. No new scheduling subsystem is needed — the
hooks config already wires arbitrary commands to lifecycle events, and systemd/cron
are the standard OS answers for periodicity. The `SessionStart` hook is the natural
fit: when a human starts a session, the audit sweep runs as a prelude (or
backgrounded), surfacing any drift since the last sweep.

### How findings become tasks

The synthesis doc is machine-parseable by convention (not a new format):

```
## HIGH
- `src/security/monitor.ts:142` · **HIGH** · rule-bypass when matcher is empty string
- `src/containment/sandbox.ts:88` · **HIGH** · fail-open when bwrap not on PATH
## MED
- `src/hooks/runner.ts:170` · **MED** · timer not cleared on fast-reject path
```

The triage step:
1. Reads `plans/audit/inhouse-findings-<date>.md` (the latest synthesis).
2. Extracts lines matching `` `path:line` · **severity** · claim ``.
3. Filters to HIGH and MED.
4. Deduplicates against a `plans/audit/.sweep-state.json` ledger (already-fixed
   findings, already-attempted-and-failed).
5. For each new finding, generates a task string.

The ledger (`plans/audit/.sweep-state.json`) makes the loop **restartable**:
```json
{
  "lastSweep": "2026-07-15T08:00:00Z",
  "findings": {
    "src/security/monitor.ts:142": { "severity": "HIGH", "claim": "rule-bypass when matcher is empty string", "status": "fixed", "pr": 342 },
    "src/containment/sandbox.ts:88": { "severity": "HIGH", "claim": "fail-open when bwrap not on PATH", "status": "attempted", "pr": null, "reason": "worker could not go green" }
  }
}
```
Entries with `status: "fixed"` or `"attempted"` are skipped on re-run. The human
triages `attempted` entries manually.

### The gate (never merge a red gate)

Every phase is gated — a red gate stops forward progress at that phase, never skips:

| Phase | Gate | Red behavior |
|---|---|---|
| Audit | subagent output is valid markdown with `file:line` findings | re-run the subagent |
| Triage | parse succeeded, at least one finding extracted | report, exit 0 (no findings is not an error) |
| Fix | `delegate auto` internal gates: `applyable` (9 gates + red→green proof) | no PR opened; finding recorded as `attempted` |
| Merge | `delegate merge` re-gates immediately before `gh pr merge` | no merge; PR left open with diagnostic |
| Merge (post-resolution) | re-gate after conflict resolution | no merge; PR left open |

A PR that passes all gates at fix time but fails the re-gate at merge time (e.g.
master advanced) is **not merged** — it's re-queued for conflict resolution, and
if resolution regresses the gate, it stays open.

### Failure handling

- **Audit subagent fails** (timeout, non-parseable output): retry once; if still
  failing, record area as `skipped` in the synthesis, continue with other areas.
- **Individual finding cannot be fixed** (worker can't go green, gate never passes):
  recorded as `attempted` in the ledger; human triages later. Does NOT block other
  findings.
- **PR merge-conflicts and resolution regresses gate**: PR left open with a comment
  listing the failing gates; finding recorded as `attempted`.
- **Sweep interrupted mid-flight**: restart picks up where it left off via the
  ledger (findings with no status are re-attempted; `fixed`/`attempted` skipped).
- **No findings**: exit 0, report empty (not an error — the repo is clean).

## New surface

- **`deepcoder audit sweep`** — the orchestrator. Thin: composes
  `runAuditPhase` → `runTriagePhase` → `runDelegateAuto` (per finding) →
  `runDelegateMerge` (all delegated PRs).
- **`deepcoder audit triage [--date <date>] [--json]`** — standalone: parse the
  latest synthesis doc, emit the task list. Useful for dry-run / inspection.

## Files to change

- **New:** `src/cli/auditSweep.ts` — `runAuditSweep()` orchestrator + CLI
  registration. Injects seams for each phase (audit, triage, fix, merge) so
  every phase is unit-testable without live models, `gh`, or real git.
- **New:** `src/audit/triage.ts` — parse synthesis doc → findings → deduplicate
  against ledger → emit task list. Pure function over strings + fs (seam-injected).
- **New:** `src/audit/sweepState.ts` — read/write `plans/audit/.sweep-state.json`
  ledger. Atomic writes (write-temp + rename).
- **Edit:** `src/cli/delegateCli.ts` — export `runDelegateAuto` and
  `runDelegateMerge` (if not already exported) so `auditSweep.ts` can call them.
- **New tests:** `test/audit-sweep.test.ts`, `test/adversarial/audit-sweep-gate.test.ts`.

## Tests (RED first, seam-injected — no live model / gh / git)

- **Full sweep, all green:** injected audit produces 2 HIGH + 1 MED findings →
  `delegate auto` called 3 times → all 3 `applyable` → 3 PRs opened →
  `delegate merge` called → all 3 merged → report shows 3/3/3.
- **Finding can't be fixed:** one worker never reaches `applyable` → no PR for
  that finding → ledger records `attempted` → merge proceeds for the other 2.
- **Merge blocked by gate:** PR is `applyable` at fix time but re-gate fails at
  merge time → PR not merged → recorded as `attempted`.
- **--no-fix:** stops after triage; report lists tasks but calls neither
  `delegate auto` nor `delegate merge`.
- **--no-merge:** stops after fix; PRs open, merge not called.
- **--dry-run:** no side effects (no worktrees, no PRs, no merges); reports what
  WOULD happen.
- **Restart idempotency:** ledger has 2 already-fixed findings → only the 1 new
  finding is attempted.
- **Adversarial:** a finding whose fix touches a forbidden path → `out_of_scope`
  gate fires → no PR → ledger records `attempted` (proves the scope gate blocks
  the autonomous loop, not just advises).
- **Adversarial:** synthesis doc with a finding claiming `CRITICAL` severity
  (not in the schema) → triage rejects it, does not generate a task (proves
  the triage parser doesn't blindly trust input).

## Safety / invariants (do not weaken)

- **Never merge a red gate** — `applyable` is necessary at both fix and merge
  time; the re-gate immediately before `gh pr merge` is non-negotiable.
- **Never auto-fix without adversarial verification** — every fix task uses
  `delegate auto` with `tdd: true`, which enforces the red→green proof
  (Gate 9 + `verifyManifestCoverage`). No finding is fixed without a
  self-seeded, non-vacuous regression test.
- **Depth-guarded** — the sweep orchestrator runs at depth 0 only; a delegated
  worker cannot launch another sweep (`delegateDepthFromEnv > 0` refuses).
- **Worktree-first** — every fix runs in `runWorker`'s isolated worktree;
  master is never touched until merge.
- **Provider creds** via `buildWorkerEnv` allowlist; never on argv; never logged.
- **Ledger is append-only** — status transitions are `null → fixed` or
  `null → attempted`; never overwrite a `fixed` entry. The ledger is a
  machine-written artifact, not a human-editable config.
- **No autonomous LOW fixes** — LOW findings are triaged into the report for
  human decision; the sweep never auto-fixes them (risk of churn for cosmetic
  changes).
- **Restartable, not resumable** — the sweep restarts from the ledger, not from
  a checkpoint. Interrupted in-flight work (a mid-flight `delegate auto`) is
  discarded; the finding is re-attempted on next sweep (idempotent by design,
  since the worker self-seeds and the ledger deduplicates).
- Acceptance must not require a live model — every phase has an injectable seam.

## Sequencing (after dependencies land)

The two dependencies — `delegate auto` and `delegate merge` — must be live and
green before this loop can be built. The order is:

1. `feat-autonomous-delegate-to-pr-plan.md` lands → `delegate auto` works e2e.
2. `feat-autonomous-pr-merge-plan.md` lands → `delegate merge` works e2e.
3. **This plan** — compose them into the sweep.

## Slices (each independently landable)

1. **Triage + ledger** — `src/audit/triage.ts` + `src/audit/sweepState.ts` +
   `deepcoder audit triage`. Pure parse + deduplicate; no side effects beyond
   the ledger. Testable with fixture markdown.
2. **Sweep orchestrator** — `src/cli/auditSweep.ts` + `deepcoder audit sweep`.
   Composes audit (delegated subagents), triage, `delegate auto` (per finding),
   `delegate merge --all-delegated`. All phases seam-injected.
3. **Hook integration** — document the `SessionStart` hook recipe for hands-off
   scheduling; add a smoke test that the hook fires the sweep command.
