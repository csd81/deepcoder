import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop } from "../agent/agentLoop.js";
import { restrictedRegistry } from "../tools/registry.js";
import { SubagentSidechain, sidechainStats, type SidechainRole } from "./sidechain.js";
import { newSessionId } from "../session/sessionStore.js";
import { resolveWebTools } from "../web/access.js";
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
function sidechainEnabled(opts: RunSubagentOptions): boolean {
  if (opts.sidechain !== undefined) return opts.sidechain;
  const env = (process.env.DEEPCODER_SUBAGENT_SIDECHAIN ?? "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(env);
}

export async function runSubagent(
  profile: SubagentProfile,
  task: string,
  opts: RunSubagentOptions,
): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText?: string }> {
  // Phase 10F: resolve model via router if available, else fall back to legacy.
  let model: string;
  let provider = opts.provider;
  if (opts.modelRouter && opts.providerPool) {
    const route = opts.modelRouter.resolve(profile.role ?? "review");
    model = route.model;
    provider = opts.providerPool.providerFor(route);
  } else {
    model = opts.subagentModel ?? opts.parentModel;
  }
  const registry = restrictedRegistry(profile.allowedTools);
  // Phase 10E: opt-in web access — when web is enabled (caller passed the web tool
  // instances) AND this profile opts in, add the resolved web tools to the registry.
  const webNames = resolveWebTools({
    webEnabled: (opts.webTools?.length ?? 0) > 0,
    profileWebOptIn: profile.webOptIn === true,
  });
  for (const t of opts.webTools ?? []) if (webNames.includes(t.name)) registry.register(t);
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
      provider,
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

  // Sidechain transcript (opt-in): persist the FULL subagent transcript to a
  // local JSONL audit trail OUTSIDE the parent's model-visible context. The
  // parent keeps only the aggregate stats. Best-effort — never breaks the run.
  let sidechainRunId: string | undefined;
  let stats: { entries: number; byRole: Record<string, number> } | undefined;
  if (sidechainEnabled(opts)) {
    try {
      const runId = `${profile.name.replace(/[^A-Za-z0-9_-]/g, "_")}-${newSessionId()}`;
      const chain = new SubagentSidechain(opts.workspaceRoot, runId);
      const written = [];
      for (const m of messages) {
        written.push(await chain.appendEntry({ role: m.role as SidechainRole, content: m.content, toolName: m.name }));
      }
      sidechainRunId = runId;
      stats = sidechainStats(written);
    } catch {
      // A sidechain write failure must never surface to the caller.
    }
  }

  return { result, trace: { toolsCalled, turns, model, sidechainRunId, sidechainStats: stats }, finalText };
}
