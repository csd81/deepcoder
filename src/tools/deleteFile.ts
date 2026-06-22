import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveRealPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { checkSymlinkTargetSensitivity } from "./pathGuards.js";

const schema = z.object({
  path: z.string().describe("Workspace file to delete."),
});

export const deleteFileTool: Tool = {
  name: "delete_file",
  kind: "mutate",
  description:
    "Delete a workspace file. The file must exist and must not be a directory. " +
    "Captured by checkpoints — /rollback can restore it. This is NOT recursive; directories cannot be deleted.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("delete_file", schema, raw);

    if (isSensitivePath(args.path)) {
      throw new Error(`${args.path} is protected`);
    }

    return {
      kind: "mutate",
      affectedPaths: [args.path],
      describe: () => `Delete ${args.path}`,
      async preview() {
        return { description: `Delete ${args.path}` };
      },
      async execute(ctx) {
        let real: string;

        try {
          checkSymlinkTargetSensitivity(ctx.workspaceRoot, args.path, "delete_file", "deleted");
          real = resolveRealPathInWorkspace(ctx.workspaceRoot, args.path);
        } catch (err) {
          if (err instanceof Error && err.message.includes("outside the workspace")) {
            throw new Error("out-of-workspace delete is refused");
          }
          throw err;
        }

        // Verify it exists and is a file (not a directory)
        let st;
        try {
          st = await fs.stat(real);
        } catch {
          throw new InvalidArgumentsError("delete_file", `${args.path} does not exist.`);
        }
        if (!st.isFile()) {
          throw new InvalidArgumentsError(
            "delete_file",
            `${args.path} is not a file. Only files can be deleted (no recursive directory delete).`,
          );
        }

        await ctx.capturePreImage?.(real);
        await fs.rm(real);
        ctx.writeTracker?.add(real);
        return { output: `Deleted ${args.path}` };
      },
    };
  },
};
