import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveInWorkspace, resolveReadPathInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";

const schema = z.object({
  path: z.string().describe("Path to the file, relative to the workspace root."),
  offset: z.number().int().nonnegative().optional().describe("1-indexed line to start from."),
  limit: z.number().int().positive().optional().describe("Max lines to read (default 2000)."),
});

const DEFAULT_LIMIT = 2000;
const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_LINE = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  kind: "read-only",
  description:
    "Read a UTF-8 text file from the workspace and return its contents with 1-indexed line numbers." +
    " Use offset+limit to read a slice of a large file instead of the whole file.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("read_file", schema, raw);
    return {
      kind: "read-only",
      describe: () => `Read ${args.path}`,
      async execute(ctx) {
        const blocked = (p: string) => ({
          output: `Reading ${p} is blocked: it may contain secrets (e.g. API keys). It was not read.`,
          isError: true as const,
        });
        if (isSensitivePath(args.path)) return blocked(args.path);
        // Resolve symlinks and confirm the real target is in-workspace (a symlink
        // could point at /etc/passwd or at .env). Throws → handled by the loop.
        const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.path);
        // Re-check sensitivity on the real, symlink-resolved path.
        if (isSensitivePath(displayPath(ctx.workspaceRoot, abs))) return blocked(args.path);
        // Guard against pulling a huge file (or an absurd single line) fully
        // into memory / the model context.
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) return { output: `${args.path} is a directory; use list_dir.`, isError: true };
        if (stat.size > MAX_BYTES) {
          return { output: `${args.path} is ${Math.round(stat.size / 1024)} KB; too large to read (max ${MAX_BYTES / 1024} KB).`, isError: true };
        }
        const content = await fs.readFile(abs, "utf8");
        // Key readTracker by the lexical path the user named, matching how
        // edit_file/write_file look up read-before-write.
        ctx.readTracker.add(resolveInWorkspace(ctx.workspaceRoot, args.path));
        const lines = content.split("\n");
        // offset is 1-indexed; clamp so offset 0 or 1 both start at the first line
        // (a negative start would otherwise slice from the end).
        const start = Math.max(0, (args.offset ?? 1) - 1);
        const end = start + (args.limit ?? DEFAULT_LIMIT);
        const slice = lines.slice(start, end);
        const numbered = slice
          .map((l, i) => {
            const clipped = l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "… (line truncated)" : l;
            return `${String(start + i + 1).padStart(6)}\t${clipped}`;
          })
          .join("\n");
        const truncated = end < lines.length ? `\n... (${lines.length - end} more lines)` : "";
        return { output: numbered + truncated };
      },
    };
  },
};
