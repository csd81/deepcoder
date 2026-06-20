# Phase 10G — Patch Review Browser

## Context

Delegated workers now produce isolated patches under:

`.deepcoder/delegations/<plan-id>/runs/<worker-id>/`

The apply path is intentionally strict: load plan/run artifacts, require passed checks, validate
patch scope, re-run `git apply --check`, require TTY confirmation, apply, run global checks, and
write an audit record. That is good for safety, but the human review experience is still mostly
spread across `/delegate status`, `/delegate review`, patch files, telemetry files, run logs, and
manual `git diff` commands.

This phase adds a patch review browser: a local, read-only review surface for delegated worker
patches and isolation artifacts. It should make it easy to compare workers, inspect patches,
quality gates, checks, telemetry, changed files, conflicts, and apply/discard eligibility before
calling the existing apply path.

The browser is a review layer, not a second apply implementation.

## Goals

- Provide a browsable view of delegation plans, worker runs, patches, checks, quality gates, and
  apply/discard state.
- Reuse existing apply/validator logic; never bypass `applyWorker`.
- Keep output bounded and redacted.
- Work in today's line-oriented CLI, and provide data models reusable by the future scrollable TUI.
- Make safety gates visible before apply: failed check, scope violation, quality gate block,
  sensitive/generated files, overlap, `git apply --check` result.

## Non-goals

- No automatic apply.
- No second patch applier.
- No browser web server in this phase.
- No syntax-highlighted full-screen UI until Phase 10A TUI lands.
- No editing patches in-place.

## User Experience

New slash commands:

```text
/delegate browse [plan-id]
/delegate browse <plan-id> <worker-id>
/delegate diff <plan-id> <worker-id> [--stat|--files|--full]
/delegate gates <plan-id> <worker-id>
/delegate log <plan-id> <worker-id> [--tail N]
/delegate telemetry <plan-id> <worker-id>
```

Command behavior:

- `browse` without worker: shows plan overview and workers table.
- `browse` with worker: shows one review card.
- `diff --stat`: default compact diff stat.
- `diff --files`: file list + change kind.
- `diff --full`: bounded full patch preview, never unlimited.
- `gates`: deterministic patch validation, quality gate summary, check status, apply eligibility.
- `log`: bounded redacted worker stdout/stderr summary.
- `telemetry`: bounded structured solve/worker telemetry.

Examples:

```text
plan p123 · 4 workers · status needs_review

worker-1  passed   3 files  check phase:pass  qg pass  apply ok
worker-2  failed   1 file   check phase:fail  qg skipped
worker-3  passed   0 files  empty patch       apply blocked
```

Worker card:

```text
worker-1 — Add SDK event types
status: passed · check: phase passed · quality: pass · patch: 4.2KB · sha 8c91...
changed: src/sdk/events.ts, test/sdk-events.test.ts
gates: scope ok · sensitive ok · generated ok · overlap ok · git apply --check ok
artifacts: patch.diff · run.json · telemetry.json · quality.json
next: /delegate apply p123 worker-1
```

## Review Data Model

New module:

`src/delegate/reviewBrowser.ts`

```ts
export interface DelegationReviewOverview {
  planId: string;
  planStatus: string;
  task: string;
  workers: WorkerReviewSummary[];
  warnings: string[];
}

export interface WorkerReviewSummary {
  workerId: string;
  title: string;
  status: string;
  checkPassed: boolean | null;
  changedFiles: string[];
  patchBytes: number;
  patchSha256?: string;
  qualityGate: "pass" | "blocked" | "missing" | "skipped";
  deterministicGates: GateSummary[];
  applyEligible: boolean;
  applyBlockers: string[];
}

export interface WorkerReviewDetail extends WorkerReviewSummary {
  promptPreview: string;
  summary: string;
  patchStat: PatchStat[];
  patchPreview: string;
  runLogPreview?: string;
  telemetryPreview?: unknown;
  artifactPaths: Record<string, string>;
}
```

The model is pure/read-only. Rendering is separate.

## Artifact Loading

New module:

`src/delegate/artifacts.ts`

Responsibilities:

- Validate `planId` / `workerId` with `assertSafeId` before path construction.
- Load `plan.json`, `run.json`, `patch.diff`, optional `telemetry.json`, optional quality artifact,
  optional `apply.json`.
- Return `null`/warnings for missing or corrupt artifacts instead of throwing.
- Redact all free-form text before returning it to renderers.
- Cap reads:
  - patch preview: default 80KB
  - logs: default 40KB tail
  - telemetry: default 40KB

Existing path conventions from `apply.ts` should be reused or factored so paths do not drift.

## Gate Preview

The review browser should preview the same deterministic gates as `applyWorker` without applying:

1. Worker status is `passed`.
2. Run record exists.
3. `run.checkPassed === true`.
4. Patch exists and is non-empty.
5. `validatePatch` passes using worker scope.
6. Quality gate is not blocked.
7. If mandatory quality mode is enabled, gate exists.
8. `git apply --check` would pass.
9. Dependencies already applied when relevant.
10. Global check names exist in config.

New helper:

```ts
previewApplyGates(root, planId, workerId, opts): Promise<ApplyGatePreview>
```

This helper must call `git apply --check` only when explicitly requested or when command is
interactive enough to tolerate the cost. The default `browse` can skip the git check and report it
as `not checked`; `gates` runs it.

## Diff Parsing

New module:

`src/delegate/diffView.ts`

Use existing `parseChangedPaths` from `patchValidator.ts` for paths. Add lightweight diff stat:

```ts
export interface PatchStat {
  path: string;
  added: number;
  removed: number;
  kind: "added" | "modified" | "deleted" | "renamed" | "unknown";
}
```

No full parser dependency in this phase; simple unified diff parsing is enough.

## Rendering

New module:

`src/delegate/reviewRender.ts`

Renderers:

- `renderReviewOverview(overview, opts)`
- `renderWorkerReview(detail, opts)`
- `renderPatchStat(stats)`
- `renderGatePreview(preview)`

Rules:

- Bounded line count.
- Bounded bytes.
- Redacted output.
- Deterministic output for tests.
- No terminal control sequences beyond existing chalk styling in slash command layer.

Future Phase 10A TUI can consume `DelegationReviewOverview` / `WorkerReviewDetail` directly.

## Apply/Discard Integration

The browser only points to existing commands:

- `/delegate apply <plan-id> <worker-id>`
- `/delegate discard <plan-id> <worker-id>`

It must not implement apply/discard itself.

Optional convenience later:

- `/delegate browse` could show a command hint, not run it.
- In full TUI, pressing a key can call the existing slash command handler or `applyWorker` directly, but still through the same gate.

## Files

New:

- `src/delegate/artifacts.ts`
- `src/delegate/diffView.ts`
- `src/delegate/reviewBrowser.ts`
- `src/delegate/reviewRender.ts`
- `test/adversarial/delegate-review-browser.test.ts`

Edit:

- `src/delegate/apply.ts` to export or share path/gate helpers if needed.
- `src/cli/slashCommands.ts` for new commands.
- `src/delegate/types.ts` only if review result types should live centrally.
- `README.md` or delegation docs if present.

## Tests

No live model required.

1. Overview loads a valid plan with multiple worker runs.
2. Missing run artifact yields warning, not throw.
3. Corrupt `run.json` yields warning, not throw.
4. Malicious plan/worker id with path traversal is rejected.
5. Patch preview is bounded and redacted.
6. Diff stat counts added/removed lines and changed files.
7. Gate preview blocks failed checks.
8. Gate preview blocks scope violations through `validatePatch`.
9. Gate preview reports blocked quality gate.
10. Gate preview can run `git apply --check` and surface failure.
11. Rendering large plans stays under byte/line caps.
12. `/delegate diff --full` never prints sensitive values unredacted.
13. Browser never mutates the repo or plan status.
14. Applied/discarded audit records appear in the review card.

## Rollout

### 10G.1 — Artifact Loader and Diff View

- Add safe artifact loading and diff stat/preview.
- Pure tests only.

### 10G.2 — Review Model and Renderers

- Build overview/detail models.
- Add bounded renderers.

### 10G.3 — Gate Preview

- Add deterministic gate preview and optional `git apply --check`.
- Reuse `validatePatch`.

### 10G.4 — Slash Commands

- Add `/delegate browse`, `/delegate diff`, `/delegate gates`, `/delegate log`, `/delegate telemetry`.

### 10G.5 — TUI Readiness

- Export data models for Phase 10A.
- Add docs and command examples.

## Acceptance Criteria

- A user can inspect all artifacts for a passed worker without shelling out to `cat`/`git diff`.
- The browser clearly explains why a worker can or cannot be applied.
- The browser never applies, discards, or mutates by itself.
- Output is bounded and redacted.
- Existing `/delegate apply` remains the only apply path.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should `browse` run `git apply --check` by default, or only `gates`?
- Should review cards include quality-gate full findings or only high/critical summaries by default?
- Should the browser support comparing two workers' patches side by side later?
- Should patch previews hide generated files by default even when they are present in artifacts?
