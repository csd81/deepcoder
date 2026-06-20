# Deepcoder Phase 7G - Automated Dependency Self-Healing

## Context

Phase 7E added dependency provisioning for isolated worktrees:

- symlink allowlisted dependency directories such as `node_modules`,
- expose provisioned targets to the sandbox as read-only mounts,
- keep setup commands explicit and opt-in.

That fixes many worktree/env gaps, but it is static. Checks can still fail for
environment reasons that are not the agent's code bug:

- `ModuleNotFoundError: No module named ...`,
- `Cannot find module ...`,
- missing `node_modules`,
- missing `.venv`,
- lockfile/package manager drift,
- generated package metadata absent in a temporary workspace.

When this happens inside `--solve`, local-bench, SWE generation, or delegated
workers, the agent may waste attempts debugging environment setup instead of the
actual bug.

Phase 7G adds a conservative, opt-in dependency self-healing interceptor around
check execution. It detects dependency-shaped check failures, runs exactly one
safe package-manager repair command from an allowlist, and retries the original
check.

## Goal

Automatically resolve common missing-dependency environment errors during
checks, without giving the model arbitrary package-install authority.

```text
run check
  -> dependency-shaped failure?
  -> infer safe repair command
  -> run repair through sandbox/bounded runner
  -> retry original check once
  -> report both attempts
```

## ROI

High.

Why it helps:

- avoids wasting solve attempts on environment noise,
- improves local-bench and SWE-style runs,
- reduces manual setup churn in isolated worktrees,
- keeps package-manager execution deterministic and auditable,
- reuses existing check/sandbox/bounded-process infrastructure.

## Non-Goals

- Do not let the model choose arbitrary install commands.
- Do not install global packages.
- Do not modify source files to fix dependencies.
- Do not run internet installs by default in untrusted workspaces.
- Do not auto-edit `package.json`, `pyproject.toml`, or lockfiles.
- Do not retry self-healing indefinitely.

## Trust Boundary

Dependency self-healing is not a model tool. It is a deterministic check-runner
interceptor controlled by config.

The model sees only a bounded summary:

```text
dependency repair attempted: npm ci --ignore-scripts
repair exit: 0
check retried: failed with original test assertion
```

It never receives raw package-manager logs beyond the existing redacted/capped
check artifacts.

## Config

Add to `.deepcoder/config.json`:

```json
{
  "dependencyHealing": {
    "enabled": false,
    "network": "off",
    "maxAttempts": 1,
    "allowPackageScripts": false,
    "managers": ["npm", "pnpm", "yarn", "pip"],
    "preferFrozenLockfile": true,
    "timeoutMs": 300000
  }
}
```

Environment:

```bash
DEEPCODER_DEP_HEALING=1
DEEPCODER_DEP_HEALING_NETWORK=off
```

Recommended default:

- disabled for ordinary CLI at first,
- enabled in local-bench/SWE/delegated-worker configs after tests prove safety,
- network off by default.

## Data Model

Extend `CheckRun` or add sidecar metadata:

```ts
interface DependencyHealingRecord {
  attempted: boolean;
  reason?: string;
  manager?: "npm" | "pnpm" | "yarn" | "pip";
  command?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  retriedCheckRunId?: string;
  logPath?: string;
}
```

Add to `CheckRun`:

```ts
dependencyHealing?: DependencyHealingRecord;
```

Alternative if `CheckRun` churn is risky:

```text
.deepcoder/runs/<check-id>.dependency-healing.json
```

## Detection

Add:

```text
src/dependencies/detect.ts
```

Input:

```ts
interface DependencyFailureInput {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  workspaceRoot: string;
}
```

Output:

```ts
type DependencyFailure =
  | { kind: "node_missing_module"; moduleName?: string }
  | { kind: "node_missing_node_modules" }
  | { kind: "python_module_not_found"; moduleName?: string }
  | { kind: "python_import_error"; moduleName?: string }
  | { kind: "package_manager_missing_lockfile"; manager: string }
  | { kind: "none" };
```

Patterns:

- Node:
  - `Cannot find module 'X'`
  - `ERR_MODULE_NOT_FOUND`
  - `Error [ERR_MODULE_NOT_FOUND]`
  - `sh: 1: tsx: not found`
  - `node_modules/.bin/...: not found`
- Python:
  - `ModuleNotFoundError: No module named 'X'`
  - `ImportError: No module named X`
  - `pytest: command not found`
  - `.venv/bin/python: not found`
- Lock/setup:
  - `npm ERR! Missing: ... from lock file`
  - `pnpm-lock.yaml is absent`
  - `package-lock.json not found` when `npm ci` is selected.

Detection must be conservative:

- no dependency-shaped output -> no repair,
- test assertion failures -> no repair,
- syntax/type errors -> no repair,
- timeout -> no repair by default.

## Repair Planning

Add:

```text
src/dependencies/repairPlanner.ts
```

Inputs:

- workspace root,
- detected failure,
- config,
- visible manifest files.

Outputs:

```ts
interface RepairPlan {
  manager: "npm" | "pnpm" | "yarn" | "pip";
  command: string;
  reason: string;
  networkRequired: boolean;
}
```

### Node manager selection

Order:

1. `pnpm-lock.yaml` -> `pnpm install --frozen-lockfile --ignore-scripts`
2. `yarn.lock` -> `yarn install --frozen-lockfile --ignore-scripts`
3. `package-lock.json` -> `npm ci --ignore-scripts`
4. `package.json` only -> no repair by default unless network is explicitly on
   and config permits non-frozen installs.

Do not run:

- `npm install <module-from-error>`,
- `pnpm add`,
- `yarn add`,
- any command that edits manifests/lockfiles in v1.

### Python manager selection

Order:

1. `requirements.txt` -> `python -m pip install -r requirements.txt`
2. `pyproject.toml` + `uv.lock` -> `uv sync --frozen` if `uv` is allowed/present
3. `pyproject.toml` only -> no repair by default unless explicitly configured.

For v1, prefer:

```text
python -m pip install -r requirements.txt
```

Do not run:

- `pip install <module-from-error>`,
- unpinned package installs,
- editable installs unless explicitly configured.

## Execution

Add:

```text
src/dependencies/healer.ts
```

Core API:

```ts
export async function maybeHealDependencies(
  checkRun: CheckRun,
  capturedOutput: string,
  opts: {
    workspaceRoot: string;
    signal: AbortSignal;
    sandbox?: SandboxConfig;
    config: DependencyHealingConfig;
    onData?(chunk: string): void;
  },
): Promise<DependencyHealingRecord>;
```

Execution rules:

- classify repair command with `classifyCommand`,
- if `deny`, do not run,
- run through `runBoundedProcess`,
- use `wrapCommand` with sandbox,
- force sandbox network according to config:
  - default `network: off`,
  - `network: on` only if explicitly enabled,
- cap output using existing check-run limits,
- redact logs,
- save repair log under `.deepcoder/runs/<check-id>.dependency.log`.

Important: most install commands classify as `ask`. The healer is deterministic
and config-gated, so it may run allowlisted repair commands even if they would
normally require interactive approval. This must be isolated to the healer path
and tested.

## Check Runner Integration

Modify `runCheck`:

1. Run original check as today.
2. If check passes -> return.
3. If dependency healing disabled -> return.
4. Load captured output for the failed check or get it directly from
   `runBoundedProcess`.
5. Detect dependency failure.
6. Build repair plan.
7. Run repair once.
8. If repair succeeds, retry original check once.
9. Return a `CheckRun` that references:
   - original check,
   - repair record,
   - retried check run.

Avoid recursion:

- internal retry should call a lower-level `runCheckOnce`,
- healing is never applied to the retry.

## Interaction With Workspace Isolation

If workspace isolation is active:

- repair runs in the isolated workspace, not the real repo,
- live repo manifests/lockfiles are not modified,
- if dependency directories are symlink-provisioned from the real root, repair
  must not write through the symlink unless config explicitly allows it.

Initial v1 rule:

- if a dependency directory is a symlink to real root (`node_modules` provision),
  do not run package install; emit "provisioned dependency dir is read-only /
  repair skipped".

This avoids a hidden write to the user's live dependency cache.

## Interaction With Sandbox

Package managers can be high-risk. Use sandbox by default:

- workspace write allowed,
- network off unless config says on,
- system dirs read-only via bubblewrap,
- no parent env secrets beyond normal process env redaction.

If bubblewrap is unavailable and sandbox fallback is fail/ask:

- repair refuses,
- check result includes "dependency repair skipped: sandbox unavailable".

## Commands Allowlist

Allowed repair command templates only:

```text
npm ci --ignore-scripts
npm install --ignore-scripts --package-lock-only=false   # only if explicitly non-frozen allowed
pnpm install --frozen-lockfile --ignore-scripts
yarn install --frozen-lockfile --ignore-scripts
python -m pip install -r requirements.txt
uv sync --frozen
```

The command builder must construct these strings itself. It must never
concatenate module names from error output into an install command.

## CLI / UX

`/check` output:

```text
check unit failed: ModuleNotFoundError: No module named 'pytest'
dependency healing: python -m pip install -r requirements.txt
repair: passed
retrying check unit
check unit: passed
```

`/checkpoints` and session history should not be affected.

Solve loop retry prompt should receive only a bounded summary:

```text
The check initially failed due to missing dependencies. Deepcoder ran an
allowlisted dependency repair and retried the check. The retried check failed
with: ...
```

If repair fixes the check:

```text
solved after dependency repair
```

## Tests

No network required.

### Pure tests

1. detect Node `Cannot find module`.
2. detect Node `ERR_MODULE_NOT_FOUND`.
3. detect Python `ModuleNotFoundError`.
4. test assertion output does not trigger healing.
5. syntax/type error does not trigger healing.
6. timeout does not trigger healing.
7. `package-lock.json` selects `npm ci --ignore-scripts`.
8. `pnpm-lock.yaml` selects `pnpm install --frozen-lockfile --ignore-scripts`.
9. `requirements.txt` selects `python -m pip install -r requirements.txt`.
10. module name from error is never interpolated into repair command.

### Check-runner tests with fake commands

Use tiny local scripts, not real npm/pip network:

1. first check emits `Cannot find module 'x'` and exits 1.
2. fake repair command touches a marker file and exits 0.
3. retry check sees marker and exits 0.
4. final result records repair + retried check.
5. repair failure does not retry endlessly.
6. repair runs once only.
7. repair output is redacted.
8. repair command denied by allowlist -> skipped.
9. sandbox unavailable + fail-closed -> skipped.
10. symlinked provisioned `node_modules` -> repair skipped.

### Solve integration test

Fake provider:

- attempt writes a correct fix,
- check initially fails due to dependency-shaped error,
- healer runs fake repair,
- retry check passes,
- solve loop reports solved without another model attempt.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

No live package install, no network, no live model required.

Manual optional smoke:

1. Create temp Node repo with `package-lock.json`.
2. Configure check that fails if `node_modules/.bin/tsx` absent.
3. Enable dependency healing with network off and fake local package manager shim.
4. Confirm repair runs once and retry passes.

## Risks

### Package install mutates too much

Package managers can modify lockfiles or run scripts.

Mitigation:

- prefer frozen lockfile commands,
- pass `--ignore-scripts`,
- run inside isolated workspace,
- do not run if dependency dir is symlinked to real root.

### Network supply-chain risk

Installing from the network can execute remote code or fetch untrusted packages.

Mitigation:

- network off by default,
- network on requires explicit config,
- use lockfile/frozen installs only by default.

### False detection

Some test failures include dependency-looking text in assertions.

Mitigation:

- conservative pattern matching,
- one repair max,
- artifacts show why repair ran,
- false positives cost one repair attempt, not arbitrary loops.

### Hidden environment drift

Auto-repair can hide a broken benchmark environment.

Mitigation:

- record repair in telemetry/check runs,
- report "solved after dependency repair" separately,
- benchmark reports can split code fixes from environment repairs.

## Implementation Order

1. Add `DependencyHealingConfig` to config/fileConfig.
2. Add detection module + pure tests.
3. Add repair planner + pure tests.
4. Add healer executor using `runBoundedProcess` + sandbox wrapping.
5. Refactor `runCheck` into `runCheckOnce` + optional healing wrapper.
6. Add check-runner fake repair tests.
7. Add solve integration test.
8. Add CLI rendering for repair/retry summary.
9. Document in README/ROADMAP.
10. Run full gate.

## Definition of Done

- Dependency-shaped check failures can trigger exactly one allowlisted repair.
- Repair command is deterministic and never model-chosen.
- Repair runs bounded, redacted, sandboxed, and audited.
- Original check is retried once after successful repair.
- Non-dependency failures do not trigger repair.
- Network installs are disabled by default.
- Full test gate passes without network or live package managers.
