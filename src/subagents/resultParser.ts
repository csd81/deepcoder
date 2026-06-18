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
  // Walk back to the matching opening brace, ignoring braces that appear INSIDE
  // JSON strings (with escape handling) so `{"x":"a}b"}` parses correctly.
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      // Entering a string from the right: an unescaped `"` opens it (going left).
      if (ch === '"' && !isEscaped(text, i)) inString = false;
      continue;
    }
    if (ch === '"' && !isEscaped(text, i)) {
      inString = true;
    } else if (ch === "}") {
      depth++;
    } else if (ch === "{") {
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

/** True if the char at `i` is escaped by an odd run of preceding backslashes. */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}
