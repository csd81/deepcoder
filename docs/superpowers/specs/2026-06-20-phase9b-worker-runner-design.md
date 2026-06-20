# Phase 9B — Single Worker Runner (design)

Date: 2026-06-20
Status: approved (pending spec review)
Slice: Phase 9 self-orchestration / delegated workers — slice 9B

## Goal

Run exactly one delegated worker task through Deepcoder as a **subprocess**, in an
isolated git worktree the *runner* owns, capturing a redacted/bounded log and a
patch artifact — **without ever applying** the patch to the real repo. This is the
first Phase 9 slice that executes another Deepcoder process, so it is the most
safety-sensitive. Apply, multi-worker ordering, and live runs are out of scope.

## Non-negotiable safety properties

These are the reason this slice exists; the implementation is judged against them:

1. **Provider key never appears in argv** — forwarded as an env var only, never
   interpolated into a command string.
2. **No shell** — `spawn(file, args, { shell: false })`. The worker prompt is a
   single argv element and can never be shell-interpreted.
3. **Strict env allowlist** — the child gets a curated env, never `process.env`.
4. **Own process group + hard kill** — timeout or abort `SIGKILL`s the whole group;
   no orphaned children.
5. **Bounded, redacted capture** — byte-capped, secret-redacted on line boundaries,
   for both the live stream and the persisted log.
6. **No auto-apply** — the runner produces a patch artifact and a `WorkerRun`
   record; the real repo is never mutated by this slice.
7. **Nested-delegation fail-closed** — a worker cannot recursively delegate.

## Architecture decision (locked)

**The runner owns the worktree and the patch.** The runner calls
`createIsolatedWorkspace(realRoot)`, spawns the child with `cwd = iso.isolatedRoot`,
and extracts the patch via `iso.diff()` / `iso.changedFiles()`. The child therefore
runs with **workspace isolation OFF** — it is already inside the isolated worktree,
so forcing `keep` would nest a worktree inside a worktree. (This corrects the
loosely-worded "keep or equivalent" from the design discussion: the correct forced
value is `off` precisely because the runner already isolated.)

Rejected alternative: child owns its own worktree via `--workspace-isolation keep`
and the runner scrapes the child's `.deepcoder/isolation-<ts>.patch` artifact —
fragile (path discovery by parsing output / scanning the FS) and gives the runner
no direct control over extraction or cleanup.

## Reuse (do not reinvent)

- `src/checks/runner.ts` `runCheck` already implements properties 4 and 5 exactly
  (detached process group, `SIGKILL` on timeout/abort, `CHECK_LOG_MAX_BYTES` cap,
  line-boundary `redactSecrets`, never-throw-on-nonzero).
- `src/workspaceIsolation` `createIsolatedWorkspace` / `IsolatedWorkspace`
  (`diff()`, `changedFiles()`, `applyPatchToRealRoot()`, `cleanup()`; refuses a
  dirty tree).
- `src/workspace/redact.ts` `redactSecrets`.
- `src/delegate/store.ts` `savePlan` / `loadPlan`; `src/delegate/types.ts`
  `WorkerRun` / `WorkerTask` / `DelegationPlan`.

## Component 1 — `src/process/runBoundedProcess.ts` (extraction)

Extract the bounded-spawn engine out of `runCheck` into a shared, reusable unit so
both `runCheck` and the worker runner share **byte-identical** security semantics
(process-group kill, timeout, byte cap, line-boundary redaction, streaming).
Duplicating this logic across two call sites risks drift in security-critical code.

**The extraction is mechanical and behavior-preserving:**

1. First, lift the spawn/capture/kill machinery verbatim into
   `runBoundedProcess(...)`, preserving current `runCheck` behavior. `runCheck`
   keeps its public signature, its classifier gate, its sandbox wrapping, and its
   `CheckRun` persistence — only the inner spawn loop moves.
2. Add tests that pin `runCheck`'s output, exit-code, timeout, and truncation
   behavior so the refactor is provably non-regressing.
3. Only then wire `workerRunner` to the same helper.

Proposed surface:

```ts
export interface BoundedProcessInput {
  file: string;                       // executable (no shell)
  args: string[];                     // argv; secrets never belong here
  cwd: string;
  env: NodeJS.ProcessEnv;             // caller-built; never process.env by default
  signal: AbortSignal;
  timeoutMs: number;                  // clamped by caller
  maxCaptureBytes: number;
  onData?(chunk: string): void;       // redacted, line-boundary stream
}

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  captured: string;                   // redacted, byte-capped
}

export function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult>;
```

`runCheck` becomes: classifier gate → (optional) sandbox wrap → build shell argv
(`sh -c <command>` stays its concern) → `runBoundedProcess` → persist `CheckRun`.
Note `runCheck` runs a *shell command string*, so it keeps using a shell wrapper;
`runBoundedProcess` itself is shell-agnostic (it spawns `file`+`args`). The worker
runner passes `shell:false`-style `file`/`args` directly.

## Component 2 — `src/delegate/workerRunner.ts`

```ts
export type SpawnFn = (input: BoundedProcessInput) => Promise<BoundedProcessResult>;

export interface RunWorkerInput {
  realRoot: string;
  plan: DelegationPlan;
  worker: WorkerTask;
  signal: AbortSignal;
  spawnWorker?: SpawnFn;        // default: runBoundedProcess; tests inject a fake
  onData?(chunk: string): void;
  keepWorktree?: boolean;
  delegateDepth?: number;       // current depth; child gets depth+1
}

export interface RunWorkerResult {
  run: WorkerRun;              // persisted record
  patchPath: string | null;   // artifact path, or null if empty patch
  changedFiles: string[];
}
```

### Worker command (default)

```
file = process.execPath
args = ['--import','tsx', <main.ts>, '--solve','--check', <check>, <prompt>]
```

`<prompt>` is one argv element. No key, no shell.

### Env construction (strict allowlist)

Base env (copied through if present):
`PATH, HOME, LANG, LC_ALL, LC_CTYPE, TMPDIR, TERM`

Provider/config env (copied through if present):
`DEEPCODER_PROVIDER, DEEPCODER_API_KEY, DEEPCODER_BASE_URL, DEEPCODER_MODEL,
DEEPCODER_REASONER_MODEL, DEEPCODER_PLAN_FIRST, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL,
DEEPSEEK_MODEL`. `OPENAI_API_KEY` only when the resolved provider is
openai-compatible (or config explicitly requires it).

Forced child env (overrides any inherited value):
- `DEEPCODER_APPROVAL_MODE=auto`
- `DEEPCODER_DELEGATE_DEPTH=<delegateDepth + 1>`
- `DEEPCODER_WORKSPACE_ISOLATION=off`  (runner already owns the worktree)
- `NO_COLOR=1`  (stable, parseable child output)

Explicitly **never** forwarded (must be absent from the child env even if set in the
parent): the whole `process.env`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, cloud creds
(`AWS_*`, `GOOGLE_*`, `AZURE_*`), `NPM_TOKEN`, arbitrary `*_KEY`/`*_TOKEN` not on the
allowlist, Docker/socket env (`DOCKER_HOST`, `*_SOCK`), and shell/runtime injection
vars `BASH_ENV`, `ENV`, `NODE_OPTIONS`.

The allowlist is built by **explicit copy from a fixed key list** — never a denylist
filter over `process.env` (a denylist fails open on the next unknown secret var).

### Flow

1. **Fail-closed preconditions:** worker status runnable; tree not dirty
   (`createIsolatedWorkspace` refuses dirty — surface a clear message); if
   `delegateDepth > 0`, refuse (nested delegation; see Component 3).
2. `iso = createIsolatedWorkspace(realRoot)`.
3. Mark worker `running`; `savePlan`.
4. `spawnWorker({ file, args, cwd: iso.isolatedRoot, env, signal, timeoutMs,
   maxCaptureBytes, onData })`.
5. On exit: `patch = await iso.diff()`, `changed = await iso.changedFiles()`.
   Persist redacted log + patch artifact under
   `.deepcoder/delegations/<plan-id>/runs/<worker-id>/` (`patch.diff`, `worker.log`).
   The patch is the raw source diff (not redacted — it is the deliverable); the
   *log* is redacted. (Whether the patch touches `.env`/sensitive paths is a 9C
   apply-time gate, not enforced here — but the artifact dir itself is under
   `.deepcoder/`, which the sensitive-path guard already protects.)
6. Build `WorkerRun`: `exitCode` (0 ⇒ child's `--solve --check` passed), `timedOut`,
   `truncated`, `changedFiles`, `patchPath`, `logPath`, timestamps, derived
   `status` (`done` on exit 0 with a non-empty patch, else `failed`/`blocked`).
   The runner does **not** re-run the check — exit code is the signal.
7. **No apply.** `iso.cleanup()` unless `keepWorktree`. `savePlan` with final status.

## Component 3 — CLI guard `/delegate run`

`/delegate run <plan-id> <worker-id>` wires the real `runBoundedProcess` spawn.
Spawning a live model is gated: explicit confirmation + TTY; non-TTY refuses with a
clear message (consistent with the apply gate in 9C).

**Nested-delegation refusal is a CLI/config guard, not only an env convention:** if
`DEEPCODER_DELEGATE_DEPTH > 0` (i.e. this process is itself a delegated worker),
`/delegate run` refuses fail-closed unless a future explicit override exists. This
means even if a worker's prompt coaxes it into invoking `/delegate run`, the command
itself declines.

## Testing (no live model required)

Core logic is exercised via the injected `spawnWorker` seam; acceptance needs no
network and no model.

**Unit (fake `spawnWorker` that edits the worktree, returns exit 0):**
- captured patch + `changedFiles` reflect the worktree edits;
- exit 0 ⇒ `done`; non-zero ⇒ `failed`; empty patch ⇒ not `done`;
- **real root unchanged** (no auto-apply) — assert `git status` on `realRoot` clean;
- worktree cleaned up by default; retained when `keepWorktree`.

**Adversarial (`test/adversarial/`):**
- hanging fake → killed by timeout; process group dead, **no orphan**;
- fake emits a key-shaped string → persisted log + stream are **redacted**;
- prompt containing shell metacharacters (`; rm -rf /`, `$(...)`, backticks) →
  **not interpreted** (verifies `shell:false`, prompt stays one argv element);
- dirty-tree → refusal with clear message;
- **env allowlist**: assert the constructed child env contains only allowlisted +
  forced keys, the provider key is **only** in env (never in argv), and that
  `GITHUB_TOKEN`/`NODE_OPTIONS`/`SSH_AUTH_SOCK`/`NPM_TOKEN` set in the parent are
  **absent** from the child env;
- `DEEPCODER_DELEGATE_DEPTH=1` → `/delegate run` refuses.

**Extraction regression (Component 1):**
- `runCheck` output / exit-code / timeout / truncation behavior unchanged after the
  refactor (pin tests added *before* wiring `workerRunner`).

**Dry-run acceptance:** one local run of `/delegate run` against a *scripted/fake*
worker command (a tiny node script that edits a file in cwd and exits 0), proving
the end-to-end path produces a patch artifact + `WorkerRun` with no live model and
no apply.

## Gate

`npm run test:phase` green (new unit + adversarial + extraction-regression tests).
No live model. Merge to master; push only on request.

## Out of scope

Patch validation + apply (9C — already merged for validation; apply pending),
multi-worker dependency ordering (9D), context-aware delegation (9E), auto-apply
(9F), and any live model run.
