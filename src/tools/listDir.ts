import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { boundLines } from "./outputBound.js";

const schema = z.object({
  path: z.string().default(".").describe("Directory to list, relative to the workspace root."),
});

// Cap entries so an enormous directory can't flood the model context.
const MAX_ENTRIES = 1000;

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
        let entries;
        try {
          entries = await fs.readdir(abs, { withFileTypes: true });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return {
              output: `Directory not found: ${args.path}. Run list_dir on a parent to see what exists.`,
              isError: true,
            };
          }
          if (code === "EACCES") {
            return { output: `Permission denied reading ${args.path}.`, isError: true };
          }
          if (code === "ENOTDIR") {
            return { output: `${args.path} is not a directory; use read_file.`, isError: true };
          }
          return { output: `Cannot list ${args.path}: ${(err as Error).message}`, isError: true };
        }
        const lines = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git" && !isSensitivePath(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        if (lines.length === 0) return { output: "(empty)" };
        return { output: boundLines(lines, MAX_ENTRIES, "entries").join("\n") };
      },
    };
  },
};
