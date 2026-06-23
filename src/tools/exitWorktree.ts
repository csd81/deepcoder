import { z } from "zod";
import type { Tool, ToolContext, ToolInvocation, ToolResult } from "./types.js";
import { parseArgs } from "./types.js";

const schema = z.object({
  action: z.enum(["apply", "discard"]).describe("Apply changes to the real workspace or discard them."),
});

export const exitWorktreeTool: Tool = {
  name: "exit_worktree",
  description:
    "Exit the current isolated worktree and either apply changes to the real workspace or discard them. " +
    "Use 'apply' to commit the quarantined changes into the real repo; use 'discard' to throw them away.",
  kind: "session",
  schema,
  build(raw: unknown): ToolInvocation {
    const args = parseArgs("exit_worktree", schema, raw);
    return {
      kind: "session",
      describe: () => `Exit worktree (${args.action})`,
      async execute(ctx: ToolContext): Promise<ToolResult> {
        if (!ctx.worktree) {
          return { output: "Workspace isolation is unavailable here." };
        }
        if (!ctx.worktree.isActive()) {
          return { output: "No active isolated worktree to exit." };
        }
        const { changed, applied } = await ctx.worktree.exit(args.action);
        return { output: `Exited isolated worktree. Changed files: ${changed}. Applied: ${applied}.` };
      },
    };
  },
};
