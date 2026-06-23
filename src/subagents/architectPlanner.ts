/**
 * architectPlanner — runs the read-only architect subagent, parses its output
 * into a PlanBrief, and returns the plan plus its SubagentTrace.
 *
 * The architect consumes a task plus an ExplorerBrief (evidence gathered by the
 * explorer) and is instructed to emit a JSON PlanBrief: a dependency-aware,
 * topologically ordered set of implementation steps. On any failure (bad model
 * output, parse error, abort) a safe empty plan is returned. NEVER throws.
 */

import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop } from "../agent/agentLoop.js";
import { restrictedRegistry } from "../tools/registry.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { buildSubagentPrompt } from "./prompts.js";
import { architect } from "./profiles.js";
import { parsePlanBrief } from "../context/planBrief.js";
import type { PlanBrief } from "../context/planBrief.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";
import type { ExplorerBrief } from "../context/explorerBrief.js";
import type { RunSubagentOptions, SubagentTrace } from "./types.js";

export interface PlannerOutput {
  plan: PlanBrief;
  trace: SubagentTrace;
}

/**
 * Run the read-only architect subagent with a task and an explorer brief, parse
 * its output as a PlanBrief, and return the plan plus trace.
 *
 * On any failure (bad output, parse error, abort) a safe empty plan is
 * returned. NEVER throws.
 */
export async function runPlanner(
  task: string,
  explorerBrief: ExplorerBrief,
  opts: RunSubagentOptions,
): Promise<PlannerOutput> {
  // Resolve model via router if available (mirrors runExplorer).
  let model: string;
  let provider = opts.provider;
  if (opts.modelRouter && opts.providerPool) {
    const route = opts.modelRouter.resolve(architect.role ?? "plan");
    model = route.model;
    provider = opts.providerPool.providerFor(route);
  } else {
    model = opts.subagentModel ?? opts.parentModel;
  }
  const registry = restrictedRegistry(architect.allowedTools);
  const { text: instructions } = loadInstructions(opts.workspaceRoot);

  const briefText = renderExplorerBrief(explorerBrief);
  const taskText = [
    `Produce an implementation plan for the task: ${task}`,
    "",
    "Explorer brief (read-only evidence gathered about the repository):",
    briefText,
    "",
    "Return a single JSON object (no prose around it) with these fields:",
    '  "summary": string — what the plan accomplishes',
    '  "orderedSteps": [{ "id": string, "description": string, "filesToTouch": string[], "testsToAddOrRun": string[], "rationale": string, "dependsOn": string[] }]',
    '  "risks": string[]',
    '  "assumptions": string[]',
    '  "openQuestions": string[]',
    "",
    "Each step needs a stable id. dependsOn entries must reference ids of other steps and form a DAG (no cycles).",
    "Be concrete and bounded.",
  ].join("\n");

  const messages: AgentMessage[] = [
    { role: "system", content: buildSubagentPrompt(architect, opts.workspaceRoot, instructions) },
    { role: "user", content: taskText },
  ];

  const ctx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    signal: opts.signal,
    readTracker: new Set(),
    todos: [],
    history: messages,
  };

  const toolsCalled: string[] = [];
  const notices: string[] = [];
  let finalText = "";

  try {
    finalText = await runAgentLoop(messages, {
      provider,
      registry,
      ctx,
      model,
      mode: "readonly",
      maxTurns: architect.maxTurns,
      contextBudgetTokens: architect.contextBudgetTokens,
      compactAt: opts.compactAt,
      mcpExecuteEnabled: false,
      approve: async () => false,
      onToolCall: (name) => toolsCalled.push(name),
      onNotice: (m) => notices.push(m),
    });
  } catch {
    // Any error → safe empty plan (parsePlanBrief("") yields the empty plan).
    return { plan: parsePlanBrief(""), trace: { toolsCalled: [], turns: 0, model } };
  }

  const plan = parsePlanBrief(finalText);

  const turns = messages.filter((m) => m.role === "assistant").length;
  const trace: SubagentTrace = { toolsCalled, turns, model };

  // Attach max-turns/abort notices as openQuestions.
  for (const n of notices) {
    if (/max turns|aborted/i.test(n)) {
      plan.openQuestions.push(`[planner notice] ${n}`);
    }
  }

  return { plan, trace };
}
