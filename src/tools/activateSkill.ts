import { z } from "zod";
import { activateSkill } from "../skills/activation.js";
import { parseArgs, type Tool, type ToolContext, type ToolInvocation } from "./types.js";

/**
 * Phase 7C2 — model-callable skill activation. Loads a discovered skill's body
 * at activation time and returns it as bounded, redacted guidance. It is a
 * "session" tool: it injects instruction text, never executes scripts, grants
 * tools, or expands permissions. All enforcement (enabled/disabled, trust,
 * disableModelInvocation, byte cap, redaction) lives in activateSkill().
 */
const schema = z.object({
  name: z.string().min(1).max(80),
  arguments: z.string().max(4000).optional(),
});

export const activateSkillTool: Tool = {
  name: "activate_skill",
  description:
    "Activate a discovered skill by name to load its instructions into context. " +
    "Skills are guidance only — they cannot run scripts, add tools, or change permissions.",
  kind: "session",
  schema,
  build(raw): ToolInvocation {
    const args = parseArgs("activate_skill", schema, raw);
    return {
      describe: () => `activate_skill ${args.name}`,
      kind: "session",
      async execute(ctx: ToolContext) {
        if (!ctx.skills) {
          return { output: "Skills are not available in this session.", isError: true };
        }
        const res = await activateSkill(
          { name: args.name, arguments: args.arguments, modelRequested: true },
          ctx.skills,
        );
        if (!res.ok) {
          return { output: res.message, isError: true };
        }
        return { output: res.modelText ?? res.message };
      },
    };
  },
};
