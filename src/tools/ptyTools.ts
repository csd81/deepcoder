/**
 * Phase 10G — gated persistent-shell tool factory.
 *
 * Wraps the tested pty/session core behind a single model-callable execute tool.
 * Returns NO tools when disabled (default-off / fail-closed: no model-callable
 * interactive shell exists unless explicitly enabled in config). When enabled,
 * exposes `run_in_shell`, an `execute`-kind tool so every write flows through the
 * same command permission policy as run_bash — the written input IS the
 * invocation's `command`, so dangerous-input checks apply.
 *
 * One persistent PtySession is created lazily per factory instance (one per
 * session) and reused across calls; it is respawned if it has exited.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { createPtySession, type PtyChild, type PtySession } from "../pty/session.js";
import { boundText } from "./outputBound.js";

/**
 * Cap on snapshot lines surfaced to the model. The session buffer is byte-bounded
 * (64KB) but that is still far more lines than a model should ingest per call, so
 * line-cap with an explicit marker. Head-bounded to match run_bash.
 */
const MAX_SHELL_LINES = 400;

export interface PtyToolsOptions {
  /** Default-off: when false, no shell tool is exposed at all. */
  enabled: boolean;
  /** Injected spawn seam (tests pass a fake child); defaults to a real login shell. */
  spawn?: () => PtyChild;
  /** Shell binary for the real spawn (default: $SHELL or /bin/bash). */
  shell?: string;
  /** ms to wait after writing before snapshotting output (lets async output arrive). */
  settleMs?: number;
}

/** Adapt a real child_process to the minimal PtyChild seam. */
function spawnRealShell(shell: string): PtyChild {
  const child = spawn(shell, ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: { write: (s: string) => void child.stdin?.write(s) },
    stdout: { on: (_ev, cb) => void child.stdout?.on("data", cb) },
    // forward stderr into the same snapshot stream so the model sees errors
    on: (ev, cb) => {
      child.on(ev as "exit", cb as never);
      if (ev === "data") child.stderr?.on("data", cb as never);
    },
    kill: () => void child.kill(),
  };
}

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/** The persistent-shell tools available for the given config; [] when disabled. */
export function createPtyTools(opts: PtyToolsOptions): Tool[] {
  if (!opts.enabled) return [];

  const settleMs = opts.settleMs ?? 200;
  const spawnFn = opts.spawn ?? (() => spawnRealShell(opts.shell ?? process.env.SHELL ?? "/bin/bash"));
  let session: PtySession | null = null;
  const ensure = (): PtySession => {
    if (!session || !session.alive) session = createPtySession({ spawn: spawnFn });
    return session;
  };

  const schema = z.object({
    input: z
      .string()
      .default("")
      .describe("Text written to the persistent shell's stdin. Append \\n to run a command."),
    read_only: z
      .boolean()
      .default(false)
      .describe("When true, do not write — just return the latest accumulated output."),
  });

  const tool: Tool<typeof schema> = {
    name: "run_in_shell",
    kind: "execute",
    description:
      "Write to a long-lived interactive shell session and return its accumulated output. " +
      "The session persists across calls (stateful: cd, env vars, REPLs survive). " +
      "Subject to the command permission policy. Use read_only to poll for more output." +
      " Do NOT use for file operations (read, write, edit) — use the dedicated tools instead.",
    schema,
    build(raw): ToolInvocation {
      const args = parseArgs("run_in_shell", schema, raw);
      return {
        kind: "execute",
        command: args.input,
        describe: () => (args.read_only ? "pty> (read)" : `pty> ${args.input}`),
        async execute() {
          const s = ensure();
          if (!args.read_only) s.write(args.input);
          await delay(settleMs);
          return { output: boundText(s.snapshot(), MAX_SHELL_LINES) };
        },
      };
    },
  };

  return [tool];
}
