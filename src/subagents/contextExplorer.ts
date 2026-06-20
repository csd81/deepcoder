/**
 * contextExplorer — runs the read-only explorer subagent, parses its output
 * into an ExplorerBrief, and returns the brief plus its SubagentTrace.
 *
 * The explorer is instructed to emit a JSON ExplorerBrief. On any failure
 * (bad model output, parse error, abort) a safe empty brief is returned.
 * NEVER throws.
 */

import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop } from "../agent/agentLoop.js";
import { restrictedRegistry } from "../tools/registry.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { buildSubagentPrompt } from "./prompts.js";
import { explorer } from "./profiles.js";
import { parseExplorerBrief } from "../context/explorerBrief.js";
import type { ExplorerBrief } from "../context/explorerBrief.js";
import type { RunSubagentOptions, SubagentTrace } from "./types.js";

export interface ExplorerOutput {
  brief: ExplorerBrief;
  trace: SubagentTrace;
}

/**
 * Run the read-only explorer subagent with a question/task, parse its output
 * as an ExplorerBrief, and return the brief plus trace.
 *
 * The subagent is instructed to emit a single JSON object matching the
 * ExplorerBrief schema. On any failure (bad output, parse error, abort) a
 * safe empty brief is returned. NEVER throws.
 */
export async function runExplorer(
  question: string,
  opts: RunSubagentOptions,
): Promise<ExplorerOutput> {
  // Phase 10F: resolve model via router if available.
  let model: string;
  let provider = opts.provider;
  if (opts.modelRouter && opts.providerPool) {
    const route = opts.modelRouter.resolve(explorer.role ?? "explore");
    model = route.model;
    provider = opts.providerPool.providerFor(route);
  } else {
    model = opts.subagentModel ?? opts.parentModel;
  }
  const registry = restrictedRegistry(explorer.allowedTools);
  const { text: instructions } = loadInstructions(opts.workspaceRoot);

  const task = [
    `Explore the codebase to answer: ${question}`,
    "",
    "Return a single JSON object (no prose around it) with these fields:",
    '  "summary": string — concise answer to the question',
    '  "relevantFiles": [{ "path": string, "reason": string, "citations": string[] }]',
    '  "likelyFixLocations": [{ "path": string, "confidence": "low"|"medium"|"high", "reason": string }]',
    '  "relevantTests": [{ "pathOrCommand": string, "reason": string }]',
    '  "risks": string[]',
    '  "openQuestions": string[]',
    "",
    "Every file claim must include at least one citation. Be concise and bounded.",
  ].join("\n");

  const messages: AgentMessage[] = [
    { role: "system", content: buildSubagentPrompt(explorer, opts.workspaceRoot, instructions) },
    { role: "user", content: task },
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
      maxTurns: explorer.maxTurns,
      contextBudgetTokens: explorer.contextBudgetTokens,
      compactAt: opts.compactAt,
      mcpExecuteEnabled: false,
      approve: async () => false,
      onToolCall: (name) => toolsCalled.push(name),
      onNotice: (m) => notices.push(m),
    });
  } catch {
    // Any error → safe empty brief
    return {
      brief: {
        summary: "",
        relevantFiles: [],
        likelyFixLocations: [],
        relevantTests: [],
        risks: [],
        openQuestions: [],
        trace: [],
      },
      trace: { toolsCalled: [], turns: 0, model },
    };
  }

  // Parse the raw model output into an ExplorerBrief (never throws)
  const brief = parseExplorerBrief(finalText);

  const turns = messages.filter((m) => m.role === "assistant").length;
  const trace: SubagentTrace = { toolsCalled, turns, model };

  // Attach notices about max-turns/abort as openQuestions
  for (const n of notices) {
    if (/max turns|aborted/i.test(n)) {
      brief.openQuestions.push(`[explorer notice] ${n}`);
    }
  }

  return { brief, trace };
}
