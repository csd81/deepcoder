import { z } from "zod";
import type { Tool, ToolContext, ToolInvocation, ToolResult } from "./types.js";
import { parseArgs } from "./types.js";
import { delegateDepthFromEnv } from "../delegate/workerRunner.js";

const PROFILES = ["reviewer", "researcher", "explorer", "testTriage", "verifier"] as const;

const schema = z.object({
  profile: z.string().optional().describe(`Which read-only subagent to run. Built-ins: ${PROFILES.join(", ")}, plus any custom disk-loaded agents. Required unless auto mode.`),
  task: z.string().min(1).describe("The focused task/question for the subagent."),
  auto: z.boolean().optional().describe(
    "Fire the full autonomous delegate-to-PR chain (plan → run → validate → pr). " +
    "Depth-guarded: refuses at delegateDepth > 0."
  ),
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
  let confirmed = 0, refuted = 0, unverifiable = 0;
  const lines = findings.map((f, i) => {
    if (typeof f === "object" && f !== null) {
      const obj = f as Record<string, unknown>;
      const hasVerdict = obj.verdict !== undefined && obj.verdict !== null;
      const verdict = obj.verdict as string | undefined;
      const verdictTag = verdict === "refuted" ? " [REFUTED]" : verdict === "unverifiable" ? " [unverified]" : "";
      if (hasVerdict) {
        if (verdict === "confirmed") confirmed++;
        else if (verdict === "refuted") refuted++;
        else unverifiable++;
      }
      const severity = obj.severity ? ` [${String(obj.severity)}]` : "";
      const claim = obj.claim ?? JSON.stringify(f);
      const file = obj.file ? ` ${String(obj.file)}` : "";
      const line = typeof obj.line === "number" ? `:${obj.line}` : "";
      const evidence = obj.evidence ? `\n      ${String(obj.evidence)}` : "";
      const verifyEvidence = obj.verifyEvidence ? `\n      → verification: ${String(obj.verifyEvidence).slice(0, 300)}` : "";
      return `${i + 1}.${verdictTag}${severity}${file}${line} ${String(claim)}${evidence}${verifyEvidence}`;
    }
    return `${i + 1}. ${String(f)}`;
  });
  const total = confirmed + refuted + unverifiable;
  const header = total > 0
    ? `\n(verified: ${confirmed} confirmed, ${refuted} refuted, ${unverifiable} unverifiable)`
    : "";
  return "\n\n" + header + "\n" + lines.join("\n");
}

export const delegateTool: Tool = {
  name: "delegate",
  description:
    "Delegate a bounded, read-only subtask to a focused subagent (reviewer, researcher, explorer, or testTriage). " +
    "The subagent runs independently with its own tool budget and returns a structured summary + findings. " +
    "Use this to investigate a specific area without polluting your own context or spending your turn budget. " +
    "Reach for this when a task spans multiple files/subsystems or has independent parts (audits, broad surveys, " +
    "\"check every X\") — delegating one subagent per area keeps your context clean and runs them in parallel, " +
    "instead of grinding through everything serially. For a single-file or localized change, just edit directly. " +
    "Once you delegate an investigation, don't also run it yourself — wait for the result, then relay what matters. " +
    "Set auto: true to fire the full autonomous delegate-to-PR chain (plan → run → validate → pr).",
  kind: "read-only",
  schema,
  build(raw: unknown): ToolInvocation {
    const args = parseArgs("delegate", schema, raw);

    if (args.auto) {
      // Depth guard: a delegated worker cannot launch auto.
      const depth = delegateDepthFromEnv(process.env);
      if (depth > 0) {
        return {
          kind: "execute",
          describe: () => `delegate auto (refused: already at depth ${depth})`,
          async execute(_ctx: ToolContext): Promise<ToolResult> {
            return {
              output: `Autonomous delegation refused: already running at delegate depth ${depth}. ` +
                `A delegated worker cannot launch another autonomous delegation.`,
              isError: true,
            };
          },
        };
      }

      return {
        kind: "execute",
        describe: () =>
          `delegate auto: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}`,
        async execute(ctx: ToolContext): Promise<ToolResult> {
          if (!ctx.delegateAuto) {
            return { output: "Autonomous delegation unavailable in this context.", isError: true };
          }
          const res = await ctx.delegateAuto.runAuto(args.task);
          if (res.exitCode === 2) {
            return {
              output: `delegate auto: plan creation failed for task "${args.task.slice(0, 80)}"`,
              isError: true,
            };
          }
          const lines = [
            `Plan: ${res.planId}`,
            `Exit code: ${res.exitCode}`,
            ...res.prUrls.map((u) => `PR: ${u}`),
          ];
          if (res.exitCode !== 0 && res.prUrls.length === 0) {
            lines.push("No PRs opened — some workers were not applyable.");
          }
          return { output: lines.join("\n"), isError: res.exitCode !== 0 };
        },
      };
    }

    // Read-only path (auto: false or absent).
    return {
      kind: "read-only",
      describe: () =>
        `Delegate to ${args.profile}: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}`,
      async execute(ctx: ToolContext): Promise<ToolResult> {
        if (!ctx.delegate) {
          return { output: "Delegation unavailable in this context.", isError: true };
        }
        const r = await ctx.delegate.run(args.profile!, args.task, ctx.signal);
        return { output: r.summary + renderFindings(r.findings) };
      },
    };
  },
};
