import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend, wrapCommand, bwrapAvailable } from "../../src/sandbox/index.js";
import { _resetBwrapCache, buildBwrapCommand } from "../../src/sandbox/bubblewrap.js";
import { DEFAULT_SANDBOX, type SandboxConfig } from "../../src/sandbox/types.js";
import { loadConfig } from "../../src/config/config.js";
import { runBashTool } from "../../src/tools/runBash.js";
import type { ToolContext } from "../../src/tools/types.js";
import { runCheck } from "../../src/checks/runner.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";
import type { Session } from "../../src/cli/repl.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({ ...DEFAULT_SANDBOX, ...over });

test("resolveBackend: off/local are literal; fast/bubblewrap follow bwrap availability; deferred → local", () => {
  assert.equal(resolveBackend("off"), "off");
  assert.equal(resolveBackend("local"), "local");
  assert.equal(resolveBackend("docker"), "local"); // deferred in MVP
  const expected = bwrapAvailable() ? "bubblewrap" : "local";
  assert.equal(resolveBackend("fast"), expected);
  assert.equal(resolveBackend("bubblewrap"), expected);
});

test("buildBwrapCommand: network=off adds --unshare-net; network=on does not", () => {
  const req = { command: "true", workspaceRoot: "/repo" };
  assert.match(buildBwrapCommand(req, cfg({ network: "off" })), /--unshare-net/);
  assert.doesNotMatch(buildBwrapCommand(req, cfg({ network: "on" })), /--unshare-net/);
});

test("buildBwrapCommand: workspace is bound writable + chdir; the inner command is single-quoted", () => {
  const out = buildBwrapCommand({ command: "npm test", workspaceRoot: "/repo" }, cfg());
  assert.match(out, /--bind '\/repo' '\/repo'/);
  assert.match(out, /--chdir '\/repo'/);
  assert.match(out, /bash -c 'npm test'$/);

  // workspaceWrite:false → read-only workspace bind.
  const ro = buildBwrapCommand({ command: "x", workspaceRoot: "/repo" }, cfg({ workspaceWrite: false }));
  assert.match(ro, /--ro-bind '\/repo' '\/repo'/);
});

test("buildBwrapCommand: extra mounts default read-only; rw only when asked", () => {
  // Use a real path that exists so the builder includes it.
  const ro = buildBwrapCommand({ command: "x", workspaceRoot: "/repo" }, cfg({ extraMounts: [{ path: "/usr", mode: "ro" }] }));
  assert.match(ro, /--ro-bind '\/usr' '\/usr'/);
  const rw = buildBwrapCommand({ command: "x", workspaceRoot: "/repo" }, cfg({ extraMounts: [{ path: "/usr", mode: "rw" }] }));
  assert.match(rw, /--bind '\/usr' '\/usr'/);
});

test("buildBwrapCommand: clears env, sets HOME to tmpfs, and never leaks a secret or mounts home/docker-sock", () => {
  process.env.SANDBOX_TEST_SECRET = "super-secret-value-123";
  try {
    const out = buildBwrapCommand({ command: "env", workspaceRoot: "/repo" }, cfg());
    assert.match(out, /--clearenv/);
    assert.match(out, /--setenv HOME \/tmp/);
    assert.doesNotMatch(out, /super-secret-value-123/, "a parent-env secret must never appear in the command");
    assert.doesNotMatch(out, /docker\.sock/, "the docker socket is never mounted");
  } finally {
    delete process.env.SANDBOX_TEST_SECRET;
  }
});

test("wrapCommand: off returns the command unchanged and unsandboxed", () => {
  const w = wrapCommand({ command: "rm -rf /", workspaceRoot: "/repo" }, cfg({ mode: "off" }));
  assert.equal(w.command, "rm -rf /");
  assert.equal(w.sandboxed, false);
  assert.equal(w.backend, "off");
});

test("wrapCommand: fast wraps with bwrap when available (else falls back, unsandboxed)", () => {
  const w = wrapCommand({ command: "echo hi", workspaceRoot: "/repo" }, cfg({ mode: "fast" }));
  if (bwrapAvailable()) {
    assert.equal(w.sandboxed, true);
    assert.equal(w.backend, "bubblewrap");
    assert.match(w.command, /^bwrap /);
  } else {
    assert.equal(w.sandboxed, false);
    assert.equal(w.command, "echo hi");
  }
});

test("wrapCommand: explicit bubblewrap with fallback=fail refuses unsafe local fallback when bwrap is unavailable", () => {
  const oldPath = process.env.PATH;
  process.env.PATH = "/definitely/no/bwrap/here";
  _resetBwrapCache();
  try {
    assert.equal(bwrapAvailable(), false);
    assert.throws(
      () => wrapCommand({ command: "echo should-not-run-locally", workspaceRoot: "/repo" }, cfg({ mode: "bubblewrap", fallback: "fail" })),
      /bwrap|bubblewrap|sandbox/i,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    _resetBwrapCache();
  }
});

test("wrapCommand: a deferred explicit mode (docker) with fallback=fail must NOT silently run local", () => {
  // Bug #1: docker/podman/runsc/sandbox-exec are configurable but unimplemented.
  // With fail-closed semantics they must refuse, not degrade to unsandboxed local.
  assert.throws(
    () => wrapCommand({ command: "echo UNSANDBOXED", workspaceRoot: "/repo" }, cfg({ mode: "docker", fallback: "fail" })),
    /docker|sandbox|not.*(available|supported|implemented)/i,
  );
  // But without fail-closed, degrading to local (unsandboxed) is acceptable.
  const lax = wrapCommand({ command: "echo ok", workspaceRoot: "/repo" }, cfg({ mode: "docker", fallback: "local" }));
  assert.equal(lax.sandboxed, false);
});

test("runCheck: a no-newline output flood stays bounded in the live stream (no unbounded buffering)", async () => {
  // Bug #2: linePending grows until a newline; a single endless line is a local DoS.
  const ws = await mkdtemp(path.join(tmpdir(), "sb-flood-"));
  let emitted = 0;
  try {
    const r = await runCheck(
      "flood",
      { command: `node -e "process.stdout.write('x'.repeat(2000000))"`, timeoutMs: 30_000 },
      { workspaceRoot: ws, signal: new AbortController().signal, onData: (c) => { emitted += c.length; } },
    );
    assert.equal(r.exitCode, 0);
    assert.ok(emitted <= 600_000, `live output must be bounded; emitted ${emitted} bytes for a 2MB no-newline flood`);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("/sandbox status surfaces fail-closed config instead of claiming it runs locally", async () => {
  // Bug #3: status computed resolveBackend(mode) without fallback, so a
  // fail-closed config was shown as "running locally".
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const oldPath = process.env.PATH;
  process.env.PATH = "/definitely/no/bwrap/here";
  _resetBwrapCache();
  try {
    const session = {
      config: { sandbox: cfg({ mode: "bubblewrap", fallback: "fail" }), workspaceRoot: "/repo" },
    } as unknown as Session;
    await handleSlashCommand("/sandbox", session, async () => {});
    const out = logs.join("\n");
    assert.match(out, /fail/i, "fail-closed status must be surfaced");
    assert.doesNotMatch(out, /running locally/i, "must not claim it runs locally when it would fail closed");
  } finally {
    console.log = orig;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    _resetBwrapCache();
  }
});

function ctxWith(sandbox: SandboxConfig | undefined, workspaceRoot: string): ToolContext {
  return { workspaceRoot, signal: new AbortController().signal, sandbox, readTracker: new Set(), todos: [] };
}

test("run_bash routes through the sandbox and still returns a normal tool result", async () => {
  const inv = runBashTool.build({ command: "echo sandboxed-ok" });
  const res = await inv.execute(ctxWith(cfg({ mode: "fast" }), process.cwd()));
  assert.match(res.output, /sandboxed-ok/);
  assert.notEqual(res.isError, true);
});

test("run_bash: a failing sandboxed command returns an error result, not a crash", async () => {
  const inv = runBashTool.build({ command: "exit 7" });
  const res = await inv.execute(ctxWith(cfg({ mode: "fast" }), process.cwd()));
  assert.equal(res.isError, true);
});

test("config precedence: env DEEPCODER_SANDBOX overrides file/default; CLI override wins over env", () => {
  const prev = process.env.DEEPCODER_SANDBOX;
  const prevKey = process.env.DEEPCODER_API_KEY;
  process.env.DEEPCODER_SANDBOX = "off";
  process.env.DEEPCODER_API_KEY = "k"; // loadConfig requires a key before it returns
  try {
    const fromEnv = loadConfig({ apiKey: "k", workspaceRoot: "/tmp" });
    assert.equal(fromEnv.sandbox.mode, "off");
    // CLI partial layers on top of env without dropping other fields.
    const fromCli = loadConfig({ apiKey: "k", workspaceRoot: "/tmp", sandbox: { mode: "fast" } });
    assert.equal(fromCli.sandbox.mode, "fast");
    assert.equal(fromCli.sandbox.network, "on"); // default preserved through the merge
  } finally {
    if (prev === undefined) delete process.env.DEEPCODER_SANDBOX;
    else process.env.DEEPCODER_SANDBOX = prev;
    if (prevKey === undefined) delete process.env.DEEPCODER_API_KEY;
    else process.env.DEEPCODER_API_KEY = prevKey;
  }
});
