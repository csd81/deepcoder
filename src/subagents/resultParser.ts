import { z } from "zod";
import type { SubagentResult } from "./types.js";

const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]).catch("medium"),
  file: z.string().optional(),
  line: z.number().optional(),
  claim: z.string(),
  evidence: z.string().default(""),
});

const resultSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(findingSchema).default([]),
  suggestedNextSteps: z.array(z.string()).default([]),
});

/**
 * Parse a subagent's final text into a structured result. Tries to extract the
 * last balanced JSON object and validate it; on ANY failure it degrades to a
 * plain text summary. Never throws.
 */
export function parseSubagentResult(profile: string, task: string, text: string): SubagentResult {
  const json = extractLastJsonObject(text);
  if (json) {
    const parsed = resultSchema.safeParse(json);
    if (parsed.success) {
      return {
        profile,
        task,
        summary: parsed.data.summary || text.trim().slice(0, 2000),
        findings: parsed.data.findings,
        suggestedNextSteps: parsed.data.suggestedNextSteps,
        errors: [],
      };
    }
  }
  // Degrade: keep the model's text as the summary so nothing is lost.
  return { profile, task, summary: text.trim().slice(0, 4000), findings: [], suggestedNextSteps: [], errors: [] };
}

/** Find the last top-level `{...}` block and JSON.parse it; null on failure. */
function extractLastJsonObject(text: string): unknown {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  // Walk back to the matching opening brace.
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
