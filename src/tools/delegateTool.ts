import { z } from "zod";
import type { Tool, ToolContext, ToolInvocation, ToolResult } from "./types.js";
import { parseArgs } from "./types.js";

const PROFILES = ["reviewer", "researcher", "explorer", "testTriage"] as const;

const schema = z.object({
  profile: z.enum(PROFILES).describe("Which read-only subagent to run."),
  task: z.string().min(1).describe("The focused task/question for the subagent."),
});

/**
 * Format an array of subagent findings into a deterministic string for the
 * tool output. Pure function — no side effects, no I/O.
 *
 * Each finding should duck-type { severity?, claim, file?, line?, evidence? }.
 * An empty list produces an empty string.
 */
export function renderFindings(findings: unknown[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f, i) => {
    if (typeof f === "object" && f !== null) {
      const obj = f as Record<string, unknown>;
      const severity = obj.severity ? ` [${String(obj.severity)}]` : "";
      const claim = obj.claim ?? JSON.stringify(f);
      const file = obj.file ? ` ${String(obj.file)}` : "";
      const line = typeof obj.line === "number" ? `:${obj.line}` : "";
      const evidence = obj.evidence ? `\n      ${String(obj.evidence)}` : "";
      return `${i + 1}.${severity}${file}${line} ${String(claim)}${evidence}`;
    }
    return `${i + 1}. ${String(f)}`;
  });
  return "\n\n" + lines.join("\n");
}

export const delegateTool: Tool = {
  name: "delegate",
  description:
    "Delegate a bounded, read-only subtask to a focused subagent (reviewer, researcher, explorer, or testTriage). " +
    "The subagent runs independently with its own tool budget and returns a structured summary + findings. " +
    "Use this to investigate a specific area without polluting your own context or spending your turn budget.",
  kind: "read-only",
  schema,
  build(raw: unknown): ToolInvocation {
    const args = parseArgs("delegate", schema, raw);
    return {
      kind: "read-only",
      describe: () =>
        `Delegate to ${args.profile}: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}`,
      async execute(ctx: ToolContext): Promise<ToolResult> {
        if (!ctx.delegate) {
          return { output: "Delegation unavailable in this context.", isError: true };
        }
        const r = await ctx.delegate.run(args.profile, args.task, ctx.signal);
        return { output: r.summary + renderFindings(r.findings) };
      },
    };
  },
};
