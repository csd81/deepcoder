/**
 * Task classifier + router for `/delegate full`.
 *
 * The model does NOT self-route to delegation (empirically: a neutral audit
 * prompt produced 0 delegate calls and ground single-threaded). This module is
 * the missing front-end: a fast model call classifies a task, and a PURE router
 * maps the category onto an EXISTING command. It does not orchestrate, review,
 * apply, or merge anything — it only routes.
 */

import type { ModelProvider } from "../providers/types.js";

export type TaskCategory = "research" | "simple-edit" | "multi-file";

export interface ClassifiedTask {
  category: TaskCategory;
  /** One short sentence, shown to the user. */
  reason: string;
  /** Best-effort, advisory — never authoritative. */
  suggestedFiles?: string[];
}

export interface ClassifyDeps {
  provider: ModelProvider;
  model: string;
  signal?: AbortSignal;
}

const CATEGORIES: readonly TaskCategory[] = ["research", "simple-edit", "multi-file"];

const SYSTEM_PROMPT = `Classify a software-engineering task into EXACTLY one category and reply with ONLY a JSON object (no prose).
Categories:
- "research": read-only understanding, analysis, explanation, or audit — no code changes.
- "simple-edit": a change confined to a single file or one localized spot.
- "multi-file": a change spanning multiple files or subsystems.
Reply format: {"category":"research|simple-edit|multi-file","reason":"<one short sentence>","suggestedFiles":["path",...]}
"suggestedFiles" is optional and best-effort.`;

/**
 * Classify a task via one fast model call. Fail-SAFE: any error or unparseable
 * output defaults to "research" (the only read-only category), so a classifier
 * failure can never escalate a task to a mutating path on its own.
 */
export async function classifyTask(task: string, deps: ClassifyDeps): Promise<ClassifiedTask> {
  let text: string;
  try {
    const res = await deps.provider.chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: task },
      ],
      tools: [],
      model: deps.model,
      temperature: 0,
      signal: deps.signal,
    });
    text = res.text ?? "";
  } catch (err) {
    return failSafe(`classifier call failed: ${(err as Error).message ?? err}`);
  }
  return parseClassification(text);
}

/** Parse the model's JSON reply into a ClassifiedTask. Pure; fail-safe to research. */
export function parseClassification(text: string): ClassifiedTask {
  const match = text.match(/\{[\s\S]*\}/); // first {...} block, tolerates surrounding prose
  if (!match) return failSafe("no JSON object in classifier output");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return failSafe("malformed classifier JSON");
  }
  const category = CATEGORIES.includes(obj.category as TaskCategory)
    ? (obj.category as TaskCategory)
    : "research";
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason given)";
  const suggestedFiles = Array.isArray(obj.suggestedFiles)
    ? obj.suggestedFiles.filter((f): f is string => typeof f === "string")
    : undefined;
  return { category, reason, suggestedFiles };
}

function failSafe(reason: string): ClassifiedTask {
  return { category: "research", reason: `defaulted to research — ${reason}` };
}

export interface RoutePlan {
  /** An EXISTING slash command to re-dispatch through handleSlashCommand. */
  command: string;
}

/**
 * Map a category onto the existing command best suited to it. PURE. The mutating
 * categories route to `/delegate autopilot`, which is already verify-first and
 * stops-and-reports by default (autoApply=false) — landing stays human-gated.
 * Research routes to the read-only `/research` subagent.
 */
export function routeFor(category: TaskCategory, task: string): RoutePlan {
  switch (category) {
    case "research":
      return { command: `/research ${task}` };
    case "simple-edit":
    case "multi-file":
      return { command: `/delegate autopilot ${task}` };
  }
}
