import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveInWorkspace } from "../workspace/paths.js";
import { isSensitivePath, SENSITIVE_GLOB_EXCLUDES } from "../workspace/sensitive.js";

const execFileAsync = promisify(execFile);

const schema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().default(".").describe("Directory or file to search, relative to workspace root."),
  glob: z.string().optional().describe("Optional glob to filter files, e.g. '*.ts'."),
});

export const grepTool: Tool = {
  name: "grep",
  kind: "read-only",
  description:
    "Search file contents for a regex using ripgrep (rg). Returns matching lines with file:line prefixes.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("grep", schema, raw);
    return {
      kind: "read-only",
      describe: () => `grep "${args.pattern}" in ${args.path}`,
      async execute(ctx) {
        if (isSensitivePath(args.path)) {
          return {
            output: `Searching ${args.path} is blocked: it may contain secrets. It was not searched.`,
            isError: true,
          };
        }
        const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
        const rgArgs = ["--line-number", "--no-heading", "--color=never"];
        // Always exclude secret files so a broad search (e.g. path ".") can't
        // pull .env / .deepcoder contents into the model context.
        for (const ex of SENSITIVE_GLOB_EXCLUDES) rgArgs.push("--glob", ex);
        if (args.glob) rgArgs.push("--glob", args.glob);
        rgArgs.push(args.pattern, abs);
        try {
          const { stdout } = await execFileAsync("rg", rgArgs, {
            signal: ctx.signal,
            maxBuffer: 8 * 1024 * 1024,
          });
          const trimmed = stdout.trim();
          return { output: trimmed || "(no matches)" };
        } catch (err: unknown) {
          // rg exits 1 with no output when there are no matches.
          const e = err as { code?: number; stderr?: string };
          if (e.code === 1) return { output: "(no matches)" };
          if (e.code === "ENOENT" as unknown as number) {
            return { output: "ripgrep (rg) is not installed; install it to use grep.", isError: true };
          }
          return { output: `grep failed: ${e.stderr || String(err)}`, isError: true };
        }
      },
    };
  },
};
