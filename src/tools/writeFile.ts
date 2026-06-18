import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolContext } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveInWorkspace, resolveRealPathInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
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

    if (isSensitivePath(args.path)) {
      throw new InvalidArgumentsError("write_file", `${args.path} is a protected/secret path and cannot be written.`);
    }

    // Resolve the real write target up front (symlink-aware) and check existence
    // there, so preview/read-before-write/write all refer to the same file.
    function readExisting(ctx: ToolContext): { real: string; lexical: string; existing: string | null } {
      const lexical = resolveInWorkspace(ctx.workspaceRoot, args.path);
      const real = resolveRealPathInWorkspace(ctx.workspaceRoot, args.path);
      let existing: string | null = null;
      try {
        existing = readFileSync(real, "utf8");
      } catch {
        existing = null;
      }
      return { real, lexical, existing };
    }

    return {
      kind: "mutate",
      affectedPaths: [args.path],
      describe: () => `Write ${args.path} (${args.content.length} bytes)`,
      async preview(ctx) {
        try {
          const { real, existing } = readExisting(ctx);
          const realRel = displayPath(ctx.workspaceRoot, real);
          const target = realRel === args.path ? args.path : `${args.path} → ${realRel}`;
          if (existing === null) return { description: `Create ${target} (${args.content.length} bytes)` };
          return { description: `Overwrite ${target}`, diff: unifiedDiff(existing, args.content) };
        } catch (err) {
          return { description: `Write ${args.path} — ${(err as Error).message}` };
        }
      },
      async execute(ctx) {
        let real: string, lexical: string, existing: string | null;
        try {
          ({ real, lexical, existing } = readExisting(ctx));
        } catch (err) {
          return { output: (err as Error).message, isError: true };
        }
        if (existing !== null && !ctx.readTracker.has(lexical) && !ctx.readTracker.has(real)) {
          return {
            output: `${args.path} already exists. Read it before overwriting, or use edit_file for a partial change.`,
            isError: true,
          };
        }
        await ctx.capturePreImage?.(real); // checkpoint pre-image (no-op if disabled)
        await fs.mkdir(path.dirname(real), { recursive: true });
        await fs.writeFile(real, args.content, "utf8");
        ctx.writeTracker?.add(real);
        return { output: `${existing === null ? "Created" : "Overwrote"} ${args.path}.` };
      },
    };
  },
};
