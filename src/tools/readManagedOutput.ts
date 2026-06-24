import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { readManagedOutput } from "../session/managedOutputs.js";

const schema = z.object({
  outputId: z.string().describe("The UUID of the offloaded output to read."),
  startLine: z.number().int().positive().optional().describe("1-indexed start line for a line-range slice."),
  endLine: z.number().int().positive().optional().describe("1-indexed end line (inclusive) for a line-range slice."),
});

export const readManagedOutputTool: Tool = {
  name: "read_managed_output",
  kind: "read-only",
  description:
    "Read a managed tool output file that was offloaded to disk because it exceeded the context budget. " +
    "The output is stored under .deepcoder/outputs/output-<id>.log. Use this to read the full output or a line-range slice.",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("read_managed_output", schema, raw);
    return {
      kind: "read-only",
      describe: () => `Read managed output ${args.outputId}`,
      async execute(ctx) {
        try {
          const text = await readManagedOutput(ctx.workspaceRoot, args.outputId, {
            startLine: args.startLine,
            endLine: args.endLine,
          });
          return { output: text };
        } catch (err) {
          return { output: `read_managed_output: ${(err as Error).message}`, isError: true };
        }
      },
    };
  },
};
