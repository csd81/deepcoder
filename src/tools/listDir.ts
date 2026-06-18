import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";

const schema = z.object({
  path: z.string().default(".").describe("Directory to list, relative to the workspace root."),
});

export const listDirTool: Tool = {
  name: "list_dir",
  kind: "read-only",
  description: "List the entries of a directory in the workspace (directories marked with a trailing /).",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("list_dir", schema, raw);
    return {
      kind: "read-only",
      describe: () => `List ${args.path}`,
      async execute(ctx) {
        // Symlink-safe: listing through a symlink can't enumerate a directory
        // outside the workspace.
        const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.path);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return { output: lines.join("\n") || "(empty)" };
      },
    };
  },
};
