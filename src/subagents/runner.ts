import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop } from "../agent/agentLoop.js";
import { restrictedRegistry } from "../tools/registry.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { buildSubagentPrompt } from "./prompts.js";
import { parseSubagentResult } from "./resultParser.js";
import type { RunSubagentOptions, SubagentProfile, SubagentResult, SubagentTrace } from "./types.js";

/**
 * Run a read-only subagent. Safety is enforced two ways: a registry restricted
 * to the profile's read-only tools (small blast radius) AND `mode: "readonly"`
 * (so even a mis-listed mutating tool is denied by checkPermission). The
 * subagent gets a fresh, minimal context — NOT the parent's full history — and
 * its output is parsed into a non-authoritative result. Never throws.
 */
export async function runSubagent(
  profile: SubagentProfile,
  task: string,
  opts: RunSubagentOptions,
): Promise<{ result: SubagentResult; trace: SubagentTrace }> {
  const model = opts.subagentModel ?? opts.parentModel;
  const registry = restrictedRegistry(profile.allowedTools);
  const { text: instructions } = loadInstructions(opts.workspaceRoot);

  const messages: AgentMessage[] = [
    { role: "system", content: buildSubagentPrompt(profile, opts.workspaceRoot, instructions) },
    { role: "user", content: task },
  ];

  const ctx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    signal: opts.signal,
    readTracker: new Set(),
    // no writeTracker / capturePreImage / recordPostWrite — the subagent never mutates
    todos: [],
    history: messages,
  };

  const toolsCalled: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  let finalText = "";

  try {
    finalText = await runAgentLoop(messages, {
      provider: opts.provider,
      registry,
      ctx,
      model,
      mode: "readonly", // belt-and-suspenders: any mutate/execute is denied
      maxTurns: profile.maxTurns,
      contextBudgetTokens: profile.contextBudgetTokens,
      compactAt: opts.compactAt,
      mcpExecuteEnabled: false,
      approve: async () => false,
      onToolCall: (name) => toolsCalled.push(name),
      onNotice: (m) => notices.push(m),
    });
  } catch (err) {
    errors.push((err as Error).message ?? String(err));
  }

  const result = parseSubagentResult(profile.name, task, finalText);
  for (const n of notices) if (/max turns|aborted/i.test(n)) result.errors.push(n);
  result.errors.push(...errors);

  const turns = messages.filter((m) => m.role === "assistant").length;
  return { result, trace: { toolsCalled, turns, model } };
}
