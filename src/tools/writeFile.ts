import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveInWorkspace } from "../workspace/paths.js";

const schema = z.object({
  path: z.string().describe("File to write, relative to the workspace root. Parent dirs are created."),
  content: z.string().describe("Full file contents to write (overwrites any existing file)."),
});

export const writeFileTool: Tool = {
  name: "write_file",
  kind: "mutate",
  description: "Create or overwrite a file with the given contents. Use edit_file for partial changes.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("write_file", schema, raw);
    return {
      kind: "mutate",
      describe: () => `Write ${args.path} (${args.content.length} bytes)`,
      async execute(ctx) {
        const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
        let existed = true;
        try {
          await fs.access(abs);
        } catch {
          existed = false;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, args.content, "utf8");
        return { output: `${existed ? "Overwrote" : "Created"} ${args.path}.` };
      },
    };
  },
};
