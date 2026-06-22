import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs, InvalidArgumentsError } from "./types.js";
import { resolveRealPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { checkSymlinkTargetSensitivity } from "./pathGuards.js";

const schema = z.object({
  from: z.string().describe("Current workspace file path to rename/move."),
  to: z.string().describe("New workspace file path."),
});

export const renameFileTool: Tool = {
  name: "rename_file",
  kind: "mutate",
  description:
    "Rename or move a workspace file. The source file must exist. " +
    "The destination parent directory is created automatically if it doesn't exist. " +
    "This is a rename (fs.rename), not a copy.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("rename_file", schema, raw);

    if (isSensitivePath(args.from)) {
      throw new InvalidArgumentsError(
        "rename_file",
        `${args.from} is a protected/secret path and cannot be renamed.`,
      );
    }
    if (isSensitivePath(args.to)) {
      throw new InvalidArgumentsError(
        "rename_file",
        `${args.to} is a protected/secret path and cannot be used as a rename destination.`,
      );
    }

    return {
      kind: "mutate",
      affectedPaths: [args.from, args.to],
      describe: () => `Rename ${args.from} → ${args.to}`,
      async preview() {
        return { description: `Rename ${args.from} → ${args.to}` };
      },
      async execute(ctx) {
        let fromReal: string;
        let toReal: string;

        try {
          checkSymlinkTargetSensitivity(ctx.workspaceRoot, args.from, "rename_file", "renamed");
          checkSymlinkTargetSensitivity(ctx.workspaceRoot, args.to, "rename_file", "renamed");

          fromReal = resolveRealPathInWorkspace(ctx.workspaceRoot, args.from);
          toReal = resolveRealPathInWorkspace(ctx.workspaceRoot, args.to);
        } catch (err) {
          if (err instanceof Error && err.message.includes("outside the workspace")) {
            throw new Error("out-of-workspace destination is refused");
          }
          throw err;
        }

        // Verify source exists and is a file
        let st;
        try {
          st = await fs.stat(fromReal);
        } catch {
          throw new InvalidArgumentsError("rename_file", `${args.from} does not exist.`);
        }
        if (!st.isFile()) {
          throw new InvalidArgumentsError(
            "rename_file",
            `${args.from} is not a file. Only files can be renamed (no recursive directory rename).`,
          );
        }

        // Create destination directory
        await fs.mkdir(path.dirname(toReal), { recursive: true });

        // Capture pre-image of source (and destination if it exists)
        await ctx.capturePreImage?.(fromReal);
        const destExists = await fs.stat(toReal).then(() => true).catch(() => false);
        if (destExists) {
          await ctx.capturePreImage?.(toReal);
        }

        await fs.rename(fromReal, toReal);
        ctx.writeTracker?.add(fromReal);
        ctx.writeTracker?.add(toReal);
        return { output: `Renamed ${args.from} → ${args.to}` };
      },
    };
  },
};
