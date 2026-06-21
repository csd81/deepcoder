# Deepcoder Phase 7A — Fast Tool-Level Sandboxing

## Goal

Add real sandboxing to Deepcoder without making every run feel slow. The default should be a fast sandbox for normal development, with Docker/gVisor available later for stronger isolation.

Key design copied from Gemini/Codex/Claude style:

```text
Deepcoder process stays normal.
Only risky tool executions run inside a sandbox.
```

That means:

- CLI stays fast,
- config/session/UI stay local,
- shell/check/hook commands are isolated,
- future hooks can safely reuse the same runner.

## Why Tool-Level Sandboxing

Full Docker per session is safe but slow and awkward. Tool-level sandboxing is better:

```text
run_bash -> sandbox runner
/check   -> sandbox runner
future hooks -> sandbox runner
```

File tools keep using Deepcoder's existing path confinement.

## Default

Default mode:

```text
sandbox.mode = "fast"
```

Resolution:

```text
fast:
  Linux -> bubblewrap if available
  macOS -> sandbox-exec if available
  otherwise -> local with warning
```

On the current Linux development machine, the likely target is `bubblewrap`.

## Config

Add to `.deepcoder/config.json`:

```json
{
  "sandbox": {
    "mode": "fast",
    "network": "on",
    "workspaceWrite": true,
    "extraMounts": [],
    "timeoutMs": 120000
  }
}
```

Supported modes:

```text
off
fast
bubblewrap
sandbox-exec
docker
podman
runsc
```

Environment override:

```bash
DEEPCODER_SANDBOX=fast
DEEPCODER_SANDBOX=off
DEEPCODER_SANDBOX=docker
```

CLI override:

```bash
deepcoder --sandbox fast ...
deepcoder --sandbox off ...
```

Precedence:

```text
CLI flag > env var > config file > default fast
```

## SandboxRunner Interface

New files:

```text
src/sandbox/types.ts
src/sandbox/factory.ts
src/sandbox/localRunner.ts
src/sandbox/bubblewrapRunner.ts
src/sandbox/dockerRunner.ts
```

Interface:

```ts
interface SandboxRunRequest {
  command: string;
  cwd: string;
  workspaceRoot: string;
  timeoutMs: number;
  network: "on" | "off";
  env?: Record<string, string>;
  extraMounts?: SandboxMount[];
}

interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  sandboxed: boolean;
  backend: string;
}
```

## Use Sites

Replace raw command execution in:

```text
src/tools/runBash.ts
src/checks/runner.ts
future hooks
```

Do not sandbox:

```text
read_file/edit_file/write_file
```

Those are internal file tools already path-confined.

## Bubblewrap Backend

Use `bwrap` when available.

Basic policy:

```text
workspace: rw bind
/usr, /bin, /lib, /lib64: ro bind
/tmp: tmpfs
/proc: proc
/dev: dev
HOME: tmpfs or minimal temp home
network: optional --unshare-net when off
cwd: same workspace path
```

Example shape:

```bash
bwrap \
  --die-with-parent \
  --new-session \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --bind /repo /repo \
  --chdir /repo \
  --unshare-net \
  bash -lc "npm test"
```

If `network=on`, omit `--unshare-net`.

## Bubblewrap Caveat

Some systems restrict unprivileged user namespaces. If bwrap fails, fallback behavior depends on policy:

```text
fallback = "ask" | "local" | "fail"
```

Default:

```text
fallback = "ask"
```

For headless:

```text
fallback = "fail"
```

## Docker Backend

Useful when OS sandbox is unavailable or stronger isolation is needed.

Config:

```json
{
  "sandbox": {
    "mode": "docker",
    "image": "node:20-bookworm",
    "network": "off"
  }
}
```

Command shape:

```bash
docker run --rm \
  -v /repo:/repo \
  -w /repo \
  --network none \
  --memory 4g \
  --cpus 2 \
  --pids-limit 512 \
  --security-opt no-new-privileges \
  node:20-bookworm \
  bash -lc "npm test"
```

For `runsc`:

```bash
docker run --runtime=runsc ...
```

## Sandbox Expansion

Implement a simple v1 inspired by Gemini:

If a command fails because of sandbox restriction, return a clear result:

```text
Sandbox blocked access. Retry with:
  /sandbox-allow network
  /sandbox-allow mount /path:ro
```

Do not auto-expand in v1.

Later:

```text
Detect failure -> ask user -> rerun with expanded mount/network for this one command
```

## Slash Commands

Add:

```text
/sandbox
```

Shows:

```text
mode: fast
backend: bubblewrap
network: on
fallback: ask
workspace: /0/deepcode/deepcoder
```

Optional v1 commands:

```text
/sandbox off|fast|docker
/sandbox network on|off
```

Status-only is acceptable for the first implementation.

## Security Rules

- Never pass secrets in command strings.
- Pass env separately.
- Redact outputs.
- Default extra mounts are read-only.
- Workspace is the only writable mount.
- `.env` and `.deepcoder/` remain protected by tool policies, but note shell commands can still read workspace files unless sandbox/file policy blocks them.
- Docker socket must never be mounted by default.
- Home directory must not be mounted by default.

## Tests

Unit/adversarial tests:

1. Factory selects `bubblewrap` when available in `fast`.
2. Factory falls back safely when unavailable.
3. `network=off` adds network isolation flag.
4. Extra mounts default to read-only.
5. `run_bash` uses sandbox runner.
6. `/check` uses sandbox runner.
7. Sandbox failure returns tool result, not crash.
8. No secret appears in command logs.
9. Headless fallback does not prompt forever.
10. Docker command does not mount home or Docker socket.

Integration smoke:

```bash
npm run sandbox:smoke
```

Should test:

```text
echo ok
write inside workspace succeeds
write /tmp succeeds or isolated tmp succeeds
write outside workspace fails
network off blocks curl
```

Only run integration if backend exists.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

If `bwrap` is installed:

```bash
npm run sandbox:smoke
```

Manual:

```bash
deepcoder --sandbox fast -- "run npm test"
```

## MVP Scope

Ship:

```text
local backend
bubblewrap backend
fast mode
run_bash sandboxing
/check sandboxing
/sandbox status
tests
```

Defer:

```text
Docker backend
runsc
sandbox expansion prompts
custom mounts UI
hooks integration
```

## Implementation Order

1. Add config parsing for `sandbox`.
2. Add `SandboxRunner` interface and `local` backend.
3. Route `run_bash` through runner.
4. Route `/check` through runner.
5. Add `bubblewrap` backend.
6. Add factory + fast selection.
7. Add `/sandbox` status.
8. Add Docker backend later if time permits.
9. Add adversarial tests.
10. Add docs/ROADMAP.
