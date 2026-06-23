import { z } from "zod";
import type { Tool, ToolContext, ToolInvocation, ToolResult } from "./types.js";

export const enterWorktreeTool: Tool = {
  name: "enter_worktree",
  description:
    "Enter an isolated git worktree so file mutations are quarantined from the real repo. " +
    "All file edits, deletions, and creations happen in the worktree until you call " +
    "exit_worktree(apply|discard) to bring them into the real workspace or discard them.",
  kind: "session",
  schema: z.object({}),
  build(_raw: unknown): ToolInvocation {
    return {
      kind: "session",
      describe: () => "Enter isolated worktree",
      async execute(ctx: ToolContext): Promise<ToolResult> {
        if (!ctx.worktree) {
          return { output: "Workspace isolation is unavailable here." };
        }
        if (ctx.worktree.isActive()) {
          return { output: "Already in an isolated worktree." };
        }
        const { isolatedRoot } = await ctx.worktree.enter();
        return { output: `Entered isolated worktree at ${isolatedRoot}. All file changes are quarantined.` };
      },
    };
  },
};
