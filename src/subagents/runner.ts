import type { AgentMessage } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop } from "../agent/agentLoop.js";
import { restrictedRegistry } from "../tools/registry.js";
import { SubagentSidechain, sidechainStats, type SidechainRole } from "./sidechain.js";
import { newSessionId } from "../session/sessionStore.js";
import { createIsolatedWorkspace } from "../workspaceIsolation/index.js";
import { DEFAULT_WORKSPACE_ISOLATION } from "../workspaceIsolation/types.js";
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

/**
 * #14 — write capability is granted ONLY when ALL hold: the profile opts in
 * (`writeMode:"worktree"`), the feature is enabled, and the profile is
 * allow-listed by name. Otherwise a write profile safely degrades to read-only.
 */
function writeAllowed(profile: SubagentProfile, opts: RunSubagentOptions): boolean {
  const ws = opts.writeSubagents;
  return (
    profile.writeMode === "worktree" &&
    ws?.enabled === true &&
    Array.isArray(ws.allowedProfiles) &&
    ws.allowedProfiles.includes(profile.name)
  );
}

export async function runSubagent(
  profile: SubagentProfile,
  task: string,
  opts: RunSubagentOptions,
): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText?: string; diff?: string }> {
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

  // #14 write-capable path: gated, isolated, diff-only (never touches the parent).
  if (writeAllowed(profile, opts)) {
    return runWorktreeWriteSubagent(profile, task, opts, model, provider);
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

/**
 * #14 — run a write-capable subagent inside a DISPOSABLE git worktree. The
 * subagent's `ToolContext.workspaceRoot` is the isolated worktree, so workspace
 * confinement (`resolveInWorkspace`) ties every write to the worktree — it can
 * NEVER touch the parent checkout. Phase 1 is **diff-only**: the changes are
 * captured as a patch and returned; they are never applied. The worktree is
 * always cleaned up (unless `keepWorktreeOnFailure` and the run failed). A full
 * sidechain transcript is mandatory.
 */
async function runWorktreeWriteSubagent(
  profile: SubagentProfile,
  task: string,
  opts: RunSubagentOptions,
  model: string,
  provider: import("../providers/types.js").ModelProvider,
): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText?: string; diff?: string }> {
  const ws = opts.writeSubagents!;
  const { text: instructions } = loadInstructions(opts.workspaceRoot);
  const messages: AgentMessage[] = [
    { role: "system", content: buildSubagentPrompt(profile, opts.workspaceRoot, instructions) },
    { role: "user", content: task },
  ];
  const toolsCalled: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  let finalText = "";
  let diff = "";
  let changedFiles: string[] = [];
  let applied = false;

  let isolated;
  try {
    isolated = await createIsolatedWorkspace(opts.workspaceRoot, {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: "patch",
      keepOnSuccess: false,
      keepOnFailure: ws.keepWorktreeOnFailure,
    });
  } catch (err) {
    // Worktree provisioning failed (non-git / dirty tree). No writes happened.
    errors.push(`worktree unavailable: ${(err as Error)?.message ?? String(err)}`);
    const result = parseSubagentResult(profile.name, task, "");
    result.errors.push(...errors);
    return { result, trace: { toolsCalled, turns: 0, model }, finalText: "" };
  }

  let failed = false;
  try {
    // Write-capable registry: only the profile's allow-listed native tools (MCP
    // and PTY are never native, so they cannot appear). Writes are gated by mode
    // + checkPermission + the sensitive-path guard, and confined to the worktree.
    const registry = restrictedRegistry(profile.allowedTools);
    const ctx: ToolContext = {
      workspaceRoot: isolated.isolatedRoot,
      signal: opts.signal,
      readTracker: new Set(),
      writeTracker: new Set(),
      todos: [],
      history: messages,
      // No delegate/worktree/toolSearch runtimes → no recursive write delegation.
    };
    finalText = await runAgentLoop(messages, {
      provider,
      registry,
      ctx,
      model,
      mode: "auto", // mutating file tools auto-run INSIDE the disposable worktree
      maxTurns: profile.maxTurns,
      contextBudgetTokens: profile.contextBudgetTokens,
      compactAt: opts.compactAt,
      mcpExecuteEnabled: false,
      approve: async () => false, // no execute-tool approvals (none are registered)
      onToolCall: (name) => toolsCalled.push(name),
      onNotice: (m) => notices.push(m),
    });
    diff = await isolated.diff();
    changedFiles = await isolated.changedFiles();

    // #14 apply (Phase 7, gated): apply the worktree diff to the parent execution
    // root ONLY under `auto-if-clean` AND within the caps AND when something
    // changed. `applyPatchToRealRoot` runs `git apply --check` first and throws on
    // conflict (→ not applied). Default policy "never" never reaches here.
    const inLimits = changedFiles.length <= ws.maxChangedFiles && Buffer.byteLength(diff) <= ws.maxPatchBytes;
    if (ws.applyPolicy === "auto-if-clean" && inLimits && changedFiles.length > 0) {
      try {
        await isolated.applyPatchToRealRoot({ force: false });
        applied = true;
      } catch (err) {
        errors.push(`apply refused: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  } catch (err) {
    failed = true;
    errors.push((err as Error)?.message ?? String(err));
  } finally {
    // Cleanup is confined to the temp isolation root (the primitive guarantees it).
    if (!(failed && ws.keepWorktreeOnFailure)) {
      try {
        await isolated.cleanup();
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  const patchBytes = Buffer.byteLength(diff);
  const withinLimits = changedFiles.length <= ws.maxChangedFiles && patchBytes <= ws.maxPatchBytes;

  // Mandatory sidechain for write-capable runs: full transcript + the write event.
  let sidechainRunId: string | undefined;
  let stats: { entries: number; byRole: Record<string, number> } | undefined;
  try {
    const runId = `${profile.name.replace(/[^A-Za-z0-9_-]/g, "_")}-${newSessionId()}`;
    const chain = new SubagentSidechain(opts.workspaceRoot, runId);
    const written = [];
    for (const m of messages) {
      written.push(await chain.appendEntry({ role: m.role as SidechainRole, content: m.content, toolName: m.name }));
    }
    written.push(
      await chain.appendEntry({
        role: "system",
        content: `[write-event] changedFiles=${changedFiles.length} patchBytes=${patchBytes} withinLimits=${withinLimits} applied=${applied}`,
      }),
    );
    sidechainRunId = runId;
    stats = sidechainStats(written);
  } catch {
    /* best-effort */
  }

  const result = parseSubagentResult(profile.name, task, finalText);
  for (const n of notices) if (/max turns|aborted/i.test(n)) result.errors.push(n);
  result.errors.push(...errors);
  const turns = messages.filter((m) => m.role === "assistant").length;

  return {
    result,
    trace: {
      toolsCalled,
      turns,
      model,
      sidechainRunId,
      sidechainStats: stats,
      write: { changedFiles, patchBytes, withinLimits, applied },
    },
    finalText,
    diff,
  };
}
