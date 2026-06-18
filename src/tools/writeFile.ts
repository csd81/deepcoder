import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolContext } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveInWorkspace } from "../workspace/paths.js";
import { unifiedDiff } from "./diff.js";

const schema = z.object({
  path: z.string().describe("File to write, relative to the workspace root. Parent dirs are created."),
  content: z.string().describe("Full file contents to write (overwrites any existing file)."),
});

export const writeFileTool: Tool = {
  name: "write_file",
  kind: "mutate",
  description:
    "Create or overwrite a file with the given contents. Use edit_file for partial changes. " +
    "Overwriting an existing file requires it to have been read first.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("write_file", schema, raw);

    async function readExisting(ctx: ToolContext): Promise<{ abs: string; existing: string | null }> {
      const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
      try {
        return { abs, existing: await fs.readFile(abs, "utf8") };
      } catch {
        return { abs, existing: null };
      }
    }

    return {
      kind: "mutate",
      affectedPaths: [args.path],
      describe: () => `Write ${args.path} (${args.content.length} bytes)`,
      async preview(ctx) {
        const { existing } = await readExisting(ctx);
        if (existing === null) {
          return { description: `Create ${args.path} (${args.content.length} bytes)` };
        }
        return {
          description: `Overwrite ${args.path}`,
          diff: unifiedDiff(existing, args.content),
        };
      },
      async execute(ctx) {
        const { abs, existing } = await readExisting(ctx);
        if (existing !== null && !ctx.readTracker.has(abs)) {
          return {
            output: `${args.path} already exists. Read it before overwriting, or use edit_file for a partial change.`,
            isError: true,
          };
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, args.content, "utf8");
        return { output: `${existing === null ? "Created" : "Overwrote"} ${args.path}.` };
      },
    };
  },
};
