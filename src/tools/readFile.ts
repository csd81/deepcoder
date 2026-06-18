import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";

const schema = z.object({
  path: z.string().describe("Path to the file, relative to the workspace root."),
  offset: z.number().int().nonnegative().optional().describe("1-indexed line to start from."),
  limit: z.number().int().positive().optional().describe("Max lines to read (default 2000)."),
});

const DEFAULT_LIMIT = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  kind: "read-only",
  description:
    "Read a UTF-8 text file from the workspace and return its contents with 1-indexed line numbers.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("read_file", schema, raw);
    return {
      kind: "read-only",
      describe: () => `Read ${args.path}`,
      async execute(ctx) {
        if (isSensitivePath(args.path)) {
          return {
            output: `Reading ${args.path} is blocked: it may contain secrets (e.g. API keys). It was not read.`,
            isError: true,
          };
        }
        const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
        const content = await fs.readFile(abs, "utf8");
        ctx.readTracker.add(abs);
        const lines = content.split("\n");
        const start = (args.offset ?? 1) - 1;
        const end = start + (args.limit ?? DEFAULT_LIMIT);
        const slice = lines.slice(start, end);
        const numbered = slice
          .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
          .join("\n");
        const truncated = end < lines.length ? `\n... (${lines.length - end} more lines)` : "";
        return { output: numbered + truncated };
      },
    };
  },
};
