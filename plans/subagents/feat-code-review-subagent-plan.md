# Feature — Enhanced code-review subagent (multi-angle fan-out + 3-state verify)

## Context

Today `/review <scope>` runs a SINGLE read-only `reviewer` subagent in one pass
(`src/cli/slashCommands.ts:644-649` → `runSubagentCommand` at `:3145`), and the
adversarial `verifier` profile (`src/subagents/profiles.ts:88-99`) only runs as a
follow-up inside `buildDelegateRuntime` (`src/runtime/sessionFactory.ts:241-257`)
— NOT from `/review`. The `reviewer` profile already carries the low-effort
taxonomy (inverted condition, off-by-one, missing await, copy-paste, swallowed
error, removed guard, falsy-zero) merged from
`system-prompts/agent-prompt-code-review-part-2-low-effort-mode.md`.

What's missing is the **high-effort** behavior from
`system-prompts/agent-prompt-code-review-part-7-high-effort-mode.md:2-6`
and `…-part-3-…-modes.md:2-7`: N independent finder angles (correctness × several,
cleanup, altitude, conventions), each surfacing candidates, then a **recall-biased**
verify pass where a single un-refuted vote carries a finding, then synthesize ≤N.
This plan adds that orchestrated multi-angle fan-out + voting on top of the existing
reviewer/verifier — building NO new fan-out or adjudication machinery.

## Model

- **Effort** `low | high` (default `high` for the new path; `low` keeps today's
  single-pass behavior unchanged). High effort = 8 finder angles (3 correctness +
  3 cleanup + 1 altitude + 1 conventions), per `…part-7…:4`.
- **Finder angle** = one `reviewer` run with an angle-specific lens string prepended
  to the task. Same `reviewer` profile, same read-only tools — only the lens differs.
- **Dedup** — collapse candidates that point at the same `file:line` (keep highest
  severity; concatenate distinct claims) so the same bug found by two angles is one
  finding (cf. "record both if different reasons" — `…part-3…:5`).
- **Verify** — reuse `verifyFindings` (`src/delegate/verifyFindings.ts:128`) per
  finding: `confirmed | refuted | unverifiable`. Recall-biased synthesis: **keep
  confirmed AND unverifiable, drop only `refuted`** (`…part-7…:6`, `…part-3…:6`).
- **Output** unchanged shape — a `SubagentResult` (`src/subagents/types.ts:34`) with
  verdict-annotated `SubagentFinding[]`, confirmed-first (already sorted by
  `applyVerdicts`, `verifyFindings.ts:103-105`).

## Design

New module `src/delegate/multiAngleReview.ts` — pure helpers + one async driver,
reusing `runSubagent` + `verifyFindings`. No new subagent profiles, no new orchestrator.

### Angle lenses (pure)
```ts
export const REVIEW_ANGLES_HIGH = [
  { id: "correctness-control", lens: "Focus ONLY on control-flow correctness: inverted conditions, off-by-one, wrong branch, early return." },
  { id: "correctness-data",    lens: "Focus ONLY on data correctness: null/undefined deref, wrong-variable copy-paste, falsy-zero checks, type coercion." },
  { id: "correctness-async",   lens: "Focus ONLY on async/error correctness: missing await, unhandled rejection, error swallowed in catch, removed guard." },
  { id: "cleanup-dup",         lens: "Focus ONLY on code duplicating an existing helper (a concrete failure if they drift)." },
  { id: "cleanup-dead",       lens: "Focus ONLY on dead/unreachable code the change leaves behind." },
  { id: "cleanup-resource",    lens: "Focus ONLY on leaked/unreleased resources (handles, listeners, locks)." },
  { id: "altitude",            lens: "Focus ONLY on whether the change solves the problem at the right layer; flag concrete defects only." },
  { id: "conventions",         lens: "Focus ONLY on violated invariants/contracts in THIS codebase that cause a concrete failure." },
] as const;        // REVIEW_ANGLES_LOW = [] → the existing single pass.
```
Each finder task = `${angle.lens}\n\n${baseTask}`; the `reviewer` profile's existing
`outputGuidance` (`profiles.ts:17-23`) still demands a nameable failure scenario per
finding, matching `…part-7…:5`.

### `dedupFindings(findings): SubagentFinding[]` (pure)
Key on `${file}:${line}` (findings with no `file` are never merged). On collision keep
the max-severity entry and append the other's `claim`/`evidence` if distinct. Stable,
deterministic ordering. Distinct-reason candidates on the same line stay as one entry
whose claim names both reasons (`…part-3…:5`).

### `runMultiAngleReview(baseTask, deps): Promise<SubagentResult>` (driver)
```ts
const angles = effort === "low" ? [null] : REVIEW_ANGLES_HIGH;
// Fan out finders in parallel (read-only, no shared state) — Promise.allSettled,
// each a runSubagent(reviewer, lensTask, opts). A rejected/empty angle contributes
// zero findings (fail-safe), never aborts the batch.
const settled = await Promise.allSettled(angles.map((a) => runFinder(a, baseTask, deps)));
const merged   = dedupFindings(settled.flatMap(okFindings));
const verified = await verifyFindings(merged, verifyDeps(deps));   // REUSE — recall-biased
const kept     = verified.filter((f) => f.verdict !== "refuted");  // confirmed + unverifiable
return synthesize(kept, summary);                                  // confirmed-first, ≤ maxFindings
```
Finders run **read-only in parallel** (the existing `runSubagent` is already a fresh,
mutation-free context — `runner.ts` header doc). We deliberately reuse `verifyFindings`
rather than `buildRunnableBatches`/`runRunnableConcurrent` (`orchestrator.ts:364,450`):
that machinery is for git-worktree mutating WORKERS, not read-only finder lenses. Cross-link
[[feat-delegate-tool-plan]]. The orchestrator stays the model for the mutating delegate path.

### Wiring `/review`
`src/cli/slashCommands.ts:644` — parse an optional `--effort low|high` (default high) and
`--low` shorthand off `arg`; on `high`, call `runMultiAngleReview` via a new
`runMultiAngleReviewCommand` that mirrors `runSubagentCommand` (`:3145-3172`): fresh
`AbortController` + SIGINT, render via the existing `renderSubagentResult` (`:3174`), and
persist to the quarantined `session.reviews` (NOT model history). `low` keeps the existing
`runSubagentCommand(... reviewer ...)` call verbatim. Update `/help` text at `:2777`.

## Files to change
- **New:** `src/delegate/multiAngleReview.ts` (angles, `dedupFindings`,
  `runMultiAngleReview`), `test/multi-angle-review.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` — `/review` case (`:644`) parses `--effort`/`--low`
  and routes high→multi-angle; add `runMultiAngleReviewCommand` next to
  `runSubagentCommand` (`:3145`); `/help` line (`:2777`).
- **Reuse, do NOT modify:** `src/subagents/profiles.ts` (reviewer + verifier),
  `src/delegate/verifyFindings.ts`, `src/subagents/runner.ts`.

## Tests (RED first)
`test/multi-angle-review.test.ts` — pure helpers + driver with INJECTED `runSubagent`/
`verifyFindings` seams (no live model), mirroring the verifyFindings test style:
- `dedupFindings` merges two same-`file:line` candidates into one, keeping max severity and
  both distinct claims; leaves different lines and file-less findings separate.
- `runMultiAngleReview(effort:"high")` fans out exactly 8 finder calls (assert via spy).
- A finder that throws/returns empty contributes zero findings; the batch still completes
  and other angles' findings survive (fail-safe `Promise.allSettled`).
- `refuted` findings are dropped; `confirmed` + `unverifiable` are kept (recall-biased).
- Output is confirmed-first and capped at `maxFindings`.
- `effort:"low"` runs exactly ONE finder and SKIPS verify (byte-identical to today's pass).
- Empty merged set → `verifyFindings` not invoked, empty result (no throw).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green WITH the new tests.
2. Manual: `/review --effort high <scope>` on a diff with a real bug → multiple angles run,
   the bug is confirmed-first, a planted false claim shows `refuted` and is dropped; verdicts
   render via the existing `renderSubagentResult`. `/review <scope>` (no flag → high) and
   `/review --low <scope>` (single pass) both work.

## Safety
- Finders + verifier are all read-only: same `reviewer`/`verifier` profiles, native
  read-only tools only, `mode:"readonly"` in `runSubagent` (`runner.ts`) — no edit/run/MCP.
- Output stays NON-authoritative and quarantined to `session.reviews` (`slashCommands.ts:3167`),
  never injected into model-visible history — multiplying finders does not change the trust model.
- Fail-safe everywhere: a dead angle, a verifier failure, or a parse failure degrades to fewer
  findings / `unverifiable`, never a crash and never a silently dropped confirmed bug.
- Bounded cost: angle count is a fixed constant (8 high / 1 low); each finder keeps the
  reviewer profile's `maxTurns`/`contextBudgetTokens` (`profiles.ts:14-15`).

## Worker contract notes
- TDD: write the failing `test/multi-angle-review.test.ts` cases FIRST, then implement. A green
  `--check phase` with ZERO new tests is a vacuous pass — reject it.
- REUSE `verifyFindings` (`src/delegate/verifyFindings.ts`) for the 3-state vote and
  `runSubagent` (`src/subagents/runner.ts`) for each finder. Do NOT add a new verifier profile,
  a new adjudication parser, or new fan-out — `buildRunnableBatches`/`runRunnableConcurrent`
  (`orchestrator.ts`) are for mutating git workers and are intentionally out of scope here.
- Wire it SAME-TASK: the `/review` case must actually route to `runMultiAngleReview` (anchor the
  high-effort path) — a module that compiles but nothing calls is a failed slice.
- Keep the low-effort path byte-identical to today's `runSubagentCommand(... reviewer ...)` call.
- Related quality-only sibling: a future `/simplify` reuse pass — see [[feat-simplify-command-plan]];
  this plan is the bug-finding (correctness/security) half, that one is the cleanup half.
