# Feature — Headless delegate CLI (retire scripts/delegate.sh)

## Why

There are **two** delegation mechanisms today:

1. **Built-in pipeline** (`src/delegate/*`): `runWorker` (isolated worktree + deliberate
   env via `buildWorkerEnv`), the orchestrator (`runRunnable`/`runRunnableConcurrent`),
   and the real verification — 9 gates (`validateWorkerResult` / `loadAndValidateWorker`,
   `validation.ts`) + verify-then-force red/green proof (`verifyManifestCoverage`,
   `verify.ts`; `evaluateVerify`, `coverage.ts`). Driven only through the **interactive**
   `/delegate` slash command, which **refuses non-interactive sessions**
   (`slashCommands.ts:2100`).
2. **`scripts/delegate.sh`**: a headless/background launcher (worktree, deps + `.deepcoder`
   provisioning, `nohup` + sentinel, and the new opt-in `DELEGATE_OPEN_PR`). But its worker
   only runs `--solve --check phase` — **none of the 9 gates or the red/green proof**. Its
   verification is "manual, in-house, after the fact."

So the script is a verification-light parallel path. The goal: expose the built-in
pipeline **headlessly** so the script's hand-rolled logic can be deleted and every
delegation runs through the real gates.

## Goal

A headless, scriptable `deepcoder delegate <action>` CLI (commander subcommand, sibling
to the default prompt action in `main.ts`) that drives the built-in pipeline and emits
JSON. Then `scripts/delegate.sh` is deleted (or reduced to a one-line shim), and
`DELEGATE_OPEN_PR` gates the PR on the real `validation.json` verdict — not a bare
`--check` exit code.

Non-interactive authorization model (mirrors `--serve`, `--telemetry`): invoking the
`delegate` subcommand IS the explicit opt-in, so it lifts the interactive-only refusal
**for these commands only** (the `/delegate` slash path is unchanged).

## Slices (each red-seed → impl, independently landable)

### Slice 1 — `deepcoder delegate validate <plan-id> [worker-id] [--json]`  ⭐ start here
The smallest, highest-value piece: expose the **already-implemented** validator with no
worker spawning.
- New: a `delegate` commander subcommand in `main.ts`; `validate` action calls
  `loadAndValidateWorker(root, planId, workerId, opts)` (`validation.ts:558`).
- Output: human summary by default; `--json` prints the `WorkerValidation` object to
  stdout. **Exit 0 iff `applyable`**, non-zero otherwise (so bash can gate on it).
- All-workers mode when `worker-id` omitted: validate every run under the plan, exit
  non-zero if any is not applyable.
- Red-seed (`test/delegate-cli-validate.test.ts`): build a fake plan + run artifacts
  under a temp `.deepcoder/delegations/<plan>/runs/<worker>/`, invoke the action, assert
  JSON shape (`status`, `applyable`, `failures[]`) and exit code. Anchor the WIRED path:
  assert the commander program registers the `delegate` subcommand.
- **Immediate payoff:** `delegate-finish.sh` can call `deepcoder delegate validate … --json`
  before committing → the PR is gated on the real 9 gates, answering "does it validate
  before commit" with the actual checks.

### Slice 2 — `deepcoder delegate run <plan-id> [worker-id] [--concurrent] [--json]`
Headless worker execution.
- Calls `runRunnable` / `runRunnableConcurrent` (`orchestrator.ts:158/450`); lifts the
  non-interactive refusal for this explicit command.
- Close the provisioning gap the script covered: ensure each isolated worktree gets a
  `node_modules` symlink + a copy of `.deepcoder/` (so the `phase` check resolves). Put
  this in the worker-run path (a `provisionWorktree` hook) so it's covered for ALL callers,
  not just bash.
- `--json`: emit per-worker run status + paths.
- Red-seed: inject the `runWorker` spawn seam with a fake that writes a passing
  `run.json` + `patch.diff`; assert the command runs runnable workers and reports JSON.

### Slice 3 — `deepcoder delegate apply|pr <plan-id> [worker-id]`
- `apply`: headless `applyWorker` (`apply.ts:116`) — validates internally, applies to the
  real tree; `--json` result.
- `pr`: for applyable workers, commit + push + open PR (move `delegate-finish.sh`'s logic
  into the CLI / reuse it), gated on `validation.json.applyable`. Never merges.
- Red-seed: fake validated worker → assert apply path + PR-body assembly (mock `gh`).

### Slice 4 — Retire `scripts/delegate.sh`
- Optional `deepcoder delegate plan <task-file>` to decompose headlessly (wrap the existing
  decompose flow) so the end-to-end is `plan → run → validate → pr` in one CLI.
- Replace `delegate.sh` with either deletion or a ≤5-line shim:
  `exec node --import tsx src/cli/main.ts delegate "$@"`. Fold `DELEGATE_OPEN_PR` into
  `delegate pr`. Delete `delegate-finish.sh` once its logic lives in `delegate pr`.
- Update `docs/delegation-workflow.md` + `CLAUDE.md` to the CLI-first flow; keep the
  background pattern as `nohup deepcoder delegate run … &` + poll the JSON (or the harness's
  own backgrounding).

## Invariants to preserve (do not weaken)
- Verification stays code, not prose: `validateWorkerResult` is necessary AND now the PR
  gate. A green `--check` alone never lands work.
- Workers never run with isolation off inside the runner (`workerRunner.ts:242` throws).
- Never auto-merge; the PR is the review gate. Opt-in is the push authorization.
- Provider creds via `buildWorkerEnv` allowlist; never on argv; never logged.
- Acceptance must not require a live model — use the existing `spawnWorker`/validate seams.

## Open decisions
- Subcommand (`delegate validate …`) vs flag (`--delegate-validate …`). Subcommand is
  cleaner and matches `gh`/`git` ergonomics; confirm it composes with commander's existing
  default `[prompt...]` action (it does — `program.command("delegate")` is a sibling).
- Does `delegate run` background itself, or stay foreground and let the caller
  (`nohup`/CI/harness) background it? Recommend **foreground + JSON + exit code**; leave
  backgrounding to the caller (simpler, no sentinel files).
