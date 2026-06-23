import type { AgentMessage } from "../providers/types.js";

export interface SkillDraft {
  name: string;
  description: string;
  steps: string[];
  inputs: string[];
  successCriteria: string[];
}

export function buildSkillPrompt(messages: AgentMessage[]): string {
  // Build a trimmed representation of the session messages for the model to analyze
  const transcript = messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : m.role === "tool" ? "Tool" : "System";
      const content = m.content.slice(0, 2000);
      const toolCalls = m.toolCalls?.map((tc) => `  [tool: ${tc.name}]`).join("\n") ?? "";
      return `[${role}]\n${content}${toolCalls ? "\n" + toolCalls : ""}`;
    })
    .join("\n\n");

  return `Analyze the following conversation transcript and extract a repeatable process that could be turned into a reusable skill.

${transcript}

---

Analyze the above conversation and extract a repeatable process.

Return valid JSON only (no markdown fences, no extra text):
{
  "name": "short skill name",
  "description": "one-line description",
  "steps": ["step 1", "step 2", ...],
  "inputs": ["input file paths or parameters"],
  "successCriteria": ["what defines completion"]
}

Focus on what the USER asked and the TOOLS that were used.`;
}
