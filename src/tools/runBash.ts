import { exec } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";

const schema = z.object({
  command: z.string().describe("The bash command to run, executed from the workspace root."),
  timeout_ms: z.number().int().positive().max(600_000).default(120_000).describe("Timeout in milliseconds."),
});

export const runBashTool: Tool = {
  name: "run_bash",
  kind: "execute",
  description:
    "Run a bash command from the workspace root and return combined stdout/stderr. " +
    "Subject to the permission policy: dangerous commands are blocked or require approval.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("run_bash", schema, raw);
    return {
      kind: "execute",
      command: args.command,
      describe: () => `$ ${args.command}`,
      execute(ctx) {
        return new Promise((resolve) => {
          const child = exec(
            args.command,
            { cwd: ctx.workspaceRoot, timeout: args.timeout_ms, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const out = [stdout, stderr].filter(Boolean).join("\n").trim();
              if (err && (err as { killed?: boolean }).killed) {
                resolve({ output: `Command timed out after ${args.timeout_ms}ms.\n${out}`, isError: true });
              } else if (err) {
                const code = (err as { code?: number }).code ?? 1;
                resolve({ output: `Exit code ${code}\n${out}`, isError: true });
              } else {
                resolve({ output: out || "(no output)" });
              }
            },
          );
          ctx.signal.addEventListener("abort", () => child.kill(), { once: true });
        });
      },
    };
  },
};
