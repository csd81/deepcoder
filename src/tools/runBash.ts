import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { redactSecrets } from "../workspace/redact.js";
import { wrapCommand } from "../sandbox/index.js";

const schema = z.object({
  command: z.string().describe("The bash command to run, executed from the workspace root."),
  timeout_ms: z.number().int().positive().max(600_000).default(120_000).describe("Timeout in milliseconds."),
});

export const runBashTool: Tool = {
  name: "run_bash",
  kind: "execute",
  description:
    `Run a bash command from the workspace root. Do NOT use for file operations (read, write, edit) — use the dedicated tools instead.

Usage:
- The command runs from the workspace root. Use workdir instead of cd <dir> && <cmd>; never prepend cd to git commands (the compound can trigger a permission prompt).
- Dangerous commands (rm, sudo, chmod, redirects outside workspace) may be blocked by the permission policy.
- For git operations: stage explicit paths, never git add -A. Review changes before committing. Prefer a new commit over amending; never skip hooks (--no-verify) or signing, and avoid destructive ops (reset --hard, push --force) unless the user asks.
- Prefer read_file/grep over cat/grep in bash — the tool versions are more reliable.
- Quote file paths that contain spaces. For independent commands, issue several run_bash calls in one message instead of chaining with &&.
- Combined stdout/stderr are returned.`,
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("run_bash", schema, raw);
    return {
      kind: "execute",
      command: args.command,
      describe: () => `$ ${args.command}`,
      execute(ctx) {
        // Isolate the command when a sandbox is configured (run_bash is an
        // execute-kind tool — exactly what tool-level sandboxing targets).
        // 10S: under containment, wrapCommand throws if bubblewrap is missing —
        // fail closed with a clear message instead of an unhandled rejection.
        let toRun: string;
        try {
          toRun = ctx.sandbox
            ? wrapCommand({ command: args.command, workspaceRoot: ctx.workspaceRoot }, ctx.sandbox).command
            : args.command;
        } catch (e) {
          return Promise.resolve({ output: `Workspace containment requires bubblewrap; install it or drop --contain. (${(e as Error).message})`, isError: true });
        }
        const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
        return new Promise((resolve) => {
          if (ctx.signal.aborted) {
            resolve({ output: "Command aborted before it started.", isError: true });
            return;
          }
          // Own process group (detached) so a timeout/abort can take down the
          // whole shell tree — `exec`'s single-pid kill leaves orphaned children
          // (e.g. a backgrounded grandchild) alive. Mirrors checks/runner.ts.
          const child = spawn(toRun, { cwd: ctx.workspaceRoot, shell: true, detached: true });
          let buf = "";
          let truncated = false;
          const append = (d: Buffer) => {
            if (buf.length >= MAX_OUTPUT_BYTES) {
              truncated = true;
              return;
            }
            buf += d.toString("utf8");
            if (buf.length >= MAX_OUTPUT_BYTES) {
              buf = buf.slice(0, MAX_OUTPUT_BYTES);
              truncated = true;
            }
          };
          child.stdout?.on("data", append);
          child.stderr?.on("data", append);

          let timedOut = false;
          let settled = false;
          const killGroup = () => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            killGroup();
          }, args.timeout_ms);
          const onAbort = () => killGroup();
          ctx.signal.addEventListener("abort", onAbort, { once: true });

          const finish = (code: number | null, spawnErr?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            // Redact so secrets a command prints (e.g. `env`) can't reach the model.
            let out = redactSecrets(buf.trim());
            if (truncated) out += "\n… (output truncated)";
            if (timedOut) {
              resolve({ output: `Command timed out after ${args.timeout_ms}ms.\n${out}`, isError: true });
            } else if (spawnErr) {
              // ENOENT here means the shell binary itself couldn't be spawned;
              // surface it as a "not found, check PATH" hint the model can act on.
              const enoent = (spawnErr as NodeJS.ErrnoException).code === "ENOENT";
              const msg = enoent
                ? `command not found: ${args.command} — check it is installed / on PATH.`
                : `Failed to run command: ${spawnErr.message}`;
              resolve({ output: `${msg}\n${out}`, isError: true });
            } else if (code && code !== 0) {
              resolve({ output: `Exit code ${code}\n${out}`, isError: true });
            } else {
              resolve({ output: out || "(no output)" });
            }
          };
          child.on("error", (err) => finish(null, err));
          child.on("close", (code) => finish(code));
        });
      },
    };
  },
};
