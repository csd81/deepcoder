# Phase 10S — `--contain`: hard workspace containment

## Context

When you run deepcoder in a directory, it should only be able to touch that
directory and its subdirs — never your home, the parent dir, or sibling projects.
Today: **file tools already enforce this** (`src/workspace/paths.ts` rejects `..`,
absolute paths, and symlink escapes for read/write/edit/list/grep/semantic). The
gap is **shell commands** (`run_bash`, `!cmd`, configured checks): with `--sandbox
off`/`local`, or with the default `fast` mode on a box without bubblewrap (it
*silently* degrades to uncontained `local`), a command like `cat ../secret` or
`cat ~/.ssh/id_rsa` runs freely. This adds an opt-in `--contain` that makes shell
containment a **guaranteed, fail-closed** property.

## Decisions (user-confirmed)

- **Practical boundary.** Shell can read+write ONLY the workspace; home/parent/
  siblings are invisible (never bind-mounted); writes outside the workspace are
  impossible. System dirs (`/usr /bin /sbin /lib /lib64 /etc`) stay **read-only**
  so commands (bash/git/node, libc, TLS) can run — this is the existing bubblewrap
  behavior. Containment is **filesystem-only** (network is left as configured).
- **Opt-in, default OFF.** Enable with `--contain` / `DEEPCODER_CONTAIN=1` / config
  `containment.enabled`. Off → behavior unchanged.

## Architecture: one chokepoint

Every shell path reads `session.config.sandbox` and resolves its root as
`session.executionRoot ?? session.config.workspaceRoot`, then funnels through
`wrapCommand(req, sandbox)` → `resolveBackend`. Call sites: `runBash.ts:29`,
`checks/runner.ts:106`, `executeBang` (`repl.ts:545`), hooks (`repl.ts:140`),
`dependencies/healer.ts`. So **rewriting `config.sandbox` once in `loadConfig`**
when containment is on makes every shell path inherit it automatically — no site
can be forgotten, future ones are covered, one auditable definition.

## Design

### 1. New `src/containment/types.ts`
```ts
export interface ContainmentConfig { enabled: boolean }
export const DEFAULT_CONTAINMENT: ContainmentConfig = { enabled: false };

/** Force a fail-closed, workspace-only sandbox. */
export function applyContainment(sandbox: SandboxConfig): SandboxConfig {
  return { ...sandbox, mode: "bubblewrap", fallback: "fail", extraMounts: [] };
  // keep workspaceWrite, network, timeoutMs as-is.
}
```
- `mode:"bubblewrap"` — the real isolation backend (not `fast`, which silently
  degrades to `local`). `fallback:"fail"` — `resolveBackend` THROWS when bwrap is
  missing (fail-closed, no degrade). `extraMounts:[]` — drop any file/env-configured
  external mounts that would punch a hole. Header comment: MCP servers & the
  `run_in_shell` PTY tool are OUT of scope (not routed through `wrapCommand`).

### 2. `src/config/config.ts`
- Add `containment: ContainmentConfig` to `Config` (near `sandbox`) + to `ConfigOverrides`.
- Resolve precedence **CLI > env > file > default-off** (mirror the `diagnostics`
  env-gate idiom): `{ ...DEFAULT_CONTAINMENT, ...(file.containment ?? {}), ...(DEEPCODER_CONTAIN truthy/falsy), ...(overrides.containment ?? {}) }`.
- In the returned object, compute the effective sandbox so containment WINS over
  `--sandbox`/env/file: `sandbox: containment.enabled ? applyContainment(mergedSandbox) : mergedSandbox`, and return `containment`. (So `--sandbox off --contain` still yields bubblewrap-fail-closed.)

### 3. `src/config/fileConfig.ts`
Add a `containment?: { enabled?: boolean }` field + zod schema (mirror `sandboxSchema`), parsed in `loadFileConfig`.

### 4. `src/cli/main.ts`
- `.option("--contain", …)` + `.option("--no-contain", …)` → commander gives
  `opts.contain: boolean | undefined`. Thread `...(opts.contain !== undefined ? { containment: { enabled: opts.contain } } : {})` into `loadConfig` overrides (undefined → let env/file decide; boolean → CLI wins).
- **Early fail-closed check** (best UX), right after `loadConfig`, before `buildSession`:
  if `config.containment.enabled && !bwrapAvailable()` → `console.error` a clear
  "containment requires bubblewrap; install it or drop --contain" and `process.exit(1)`.
  (`bwrapAvailable` from `../sandbox/index.js`; cached, warms the probe.)

### 5. Glob hardening (always-on, not gated)
- `src/workspace/paths.ts`: add `validateGlobPattern(pattern)` — reject leading `/`,
  leading `..`, `/../`, trailing `/..`; allow `**/*.ts`, `src/**`, `a/b.ts`.
- `src/tools/glob.ts`: call it at the top of `execute` (before `globToRegExp`).

### 6. Per-command fail-closed surface (defense for non-CLI embedders)
`resolveBackend("bubblewrap","fail")` throws when bwrap is missing. Wrap the
`wrapCommand(...)` call in `src/tools/runBash.ts:29` and `src/checks/runner.ts:106`
in try/catch → return a clean tool/check error ("Workspace containment requires
bubblewrap; install it or drop --contain") instead of an unhandled rejection. (The
CLI's Layer-1 check means this rarely fires; it protects the SDK/server entry.)

### 7. Surfacing
- `src/permissions/summary.ts`: add `containment` to `PermissionSummary` +
  `containmentEnabled` to its input; `formatPermissionSummary` prints
  `containment: ON (workspace-locked, fail-closed)`; pass `config.containment.enabled`
  from the `/permissions` call site (`slashCommands.ts`).
- `src/doctor/doctor.ts` `collectSandbox`: emit an ok/err finding for containment
  (err when enabled but bwrap missing).

## Files to change

- **New:** `src/containment/types.ts`, `test/adversarial/containment.test.ts`,
  `test/adversarial/glob-validate.test.ts`, `test/containment-config.test.ts`.
- **Edit:** `src/config/config.ts`, `src/config/fileConfig.ts`, `src/cli/main.ts`,
  `src/workspace/paths.ts`, `src/tools/glob.ts`, `src/tools/runBash.ts`,
  `src/checks/runner.ts`, `src/permissions/summary.ts`, `src/cli/slashCommands.ts`,
  `src/doctor/doctor.ts`.

## Tests (pure seams)

- `applyContainment`: forces `bubblewrap`/`fail`; drops `extraMounts`; preserves
  `network`/`workspaceWrite`/`timeoutMs`; idempotent; doesn't mutate input.
- `validateGlobPattern`: throws on `/etc/passwd`, `../x`, `a/../b`, `..`, `src/..`;
  allows `**/*.ts`, `src/**/*.ts`, `*.md`.
- config precedence (drive `loadConfig` with env/overrides/temp `.deepcoder/config.json`,
  save/restore env): default OFF (sandbox untouched); file enable → sandbox becomes
  bubblewrap/fail/no-mounts; env `DEEPCODER_CONTAIN=1` overrides file false; CLI
  overrides env; **containment wins over `sandbox.mode:"off"`**; extraMounts dropped.
- Fail-closed throw is covered by the existing `test/adversarial/sandbox-fallback.test.ts`
  (add one assertion that the contained config triggers the same throw).

## Edge cases

- **Workspace isolation composes:** `executionRoot` (the /tmp worktree) is the
  contained root; `setupIsolation` re-adds its provisioned RO dep-symlink mounts to
  `extraMounts` AFTER `loadConfig`, so they survive the `extraMounts:[]` reset and
  resolve inside bwrap. Document this ordering so it isn't "fixed" later.
- `--sandbox off --contain` → containment wins (bubblewrap-fail-closed).
- **Out of scope (state plainly):** MCP execute tools and the `run_in_shell` PTY
  tool are NOT routed through `wrapCommand`, so `--contain` does not sandbox them in
  v1. (Hooks DO run via the sandbox, so they ARE contained.)

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green (new pure tests included).
2. Manual smoke on a box WITH bubblewrap, from a workspace `ws/` beside a `../secret`:
   `deepcoder --contain` → `!cat ./x` works; `!cat ../secret`, `!cat ~/.ssh/id_rsa`,
   `!ls /home`, `!touch ../pwned` all fail (those paths don't exist in the sandbox);
   `!cat /etc/hostname` works (system RO) but writing to `/etc` fails.
3. On a box WITHOUT bubblewrap: `deepcoder --contain` refuses at startup with the
   clear message and exits 1.
4. `/permissions` shows `containment: ON`; `/doctor` shows the containment finding.
5. Compose: `--contain --workspace-isolation patch` — edits land in the worktree,
   `!cat ../secret` still fails, provisioned deps still resolve.

## Safety

- File tools were already contained; this adds **guaranteed** shell containment.
- Fail-closed: no silent degrade to an uncontained shell — refuse instead.
- Default OFF (opt-in), matching deepcoder's new-security-feature convention.
- The model can never enable/disable it or configure mounts (CLI/env/file only).
- **First implementation step:** save this plan to
  `plans/new/phase10s-workspace-containment-plan.md` (plan mode can't write to the repo).
