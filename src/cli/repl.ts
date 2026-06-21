import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { ApprovalMode, Config } from "../config/config.js";
import type { ModelProvider, AgentMessage } from "../providers/types.js";
import { addUsage } from "../providers/usage.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult, Todo } from "../tools/types.js";
import { runAgentLoop, type AgentDeps } from "../agent/agentLoop.js";
import { runPreToolUseHooks, runAdvisoryHooks, type HookRunContext } from "../hooks/runner.js";
import type { HookEvent } from "../hooks/types.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { loadInstructions } from "../context/projectInstructions.js";
import {
  buildInstructionGraph,
  pathLocalSources,
  commitJitSource,
  type InstructionGraph,
} from "../context/instructionGraph.js";
import { promptForApproval, confirm } from "../permissions/prompt.js";
import type { ActivateSkillRuntime } from "../skills/activation.js";
import { handleSlashCommand } from "./slashCommands.js";
import { runSolveCommand } from "./solveRunner.js";
import { SessionStore, type SessionSnapshot } from "../session/sessionStore.js";
import type { McpManager } from "../mcp/registry.js";
import { CheckpointRecorder } from "../session/checkpoints.js";
import type { SubagentRunRecord } from "../subagents/types.js";
import type { BriefRunRecord } from "../context/explorerBrief.js";
import type { ModelRouter } from "../models/router.js";
import type { ProviderPool } from "../models/providerPool.js";
import { createPlainRenderer } from "../ui/plainRenderer.js";
import type { UiEvent } from "../ui/events.js";
import { createTranscript, applyEvent, type TranscriptState } from "../ui/transcript.js";
import { renderFrame, keyToAction } from "../ui/minimalRenderer.js";
import { createTuiApproval } from "../ui/approval.js";

/** Mutable runtime state for one interactive (or one-shot) session. */
export interface Session {
  config: Config;
  provider: ModelProvider;
  registry: ToolRegistry;
  store: SessionStore;
  messages: AgentMessage[];
  mode: ApprovalMode;
  /**
   * Execution root override for file tools, run_bash, and checks. Defaults to
   * config.workspaceRoot when unset; points at an isolated git worktree when
   * workspace isolation is active (control plane stays on config.workspaceRoot).
   */
  executionRoot?: string;
  /** Active isolated workspace (Phase 7D); undefined when isolation is off. */
  isolation?: import("../workspaceIsolation/types.js").IsolatedWorkspace;
  todos: Todo[];
  readTracker: Set<string>;
  /** Absolute real paths the agent has mutated this session. */
  writeTracker: Set<string>;
  /** Connected MCP servers (Phase 4A); undefined if none configured. */
  mcp?: McpManager;
  /** Pre-image recorder for checkpoints; undefined when checkpoints are off. */
  recorder?: CheckpointRecorder;
  /** Subagent run records — persisted for audit, NEVER sent to the model. */
  reviews: SubagentRunRecord[];
  /** Explorer brief records — quarantined metadata, NEVER sent to the model. */
  briefs: BriefRunRecord[];
  activatedSkills: import("../skills/types.js").ActivatedSkillRecord[];
  trustedWorkspaceSkills: Set<string>;
  /**
   * Phase 8A instruction graph (only when config.context.instructionGraph). The
   * live graph is mutated as JIT path-local sources load; `/instructions` and
   * the JIT injector read it. Undefined under the legacy first-match loader.
   */
  instructionGraph?: import("../context/instructionGraph.js").InstructionGraph;
  /** Cumulative token usage across this session's model calls. */
  tokenUsage: import("../providers/types.js").TokenUsage;
  /** Phase 10F — model router for role-based model selection. */
  modelRouter: ModelRouter;
  /** Phase 10F — provider pool for caching provider instances. */
  providerPool: ProviderPool;
  /** Phase 10C — session usage/cost telemetry (optional; persisted across resume). */
  telemetry?: import("../telemetry/sessionTelemetry.js").SessionTelemetry;
}

/**
 * Build the PreToolUse hook callback from config (Phase 7B). Returns undefined
 * when hooks are disabled or none are configured, so the agent loop behaves
 * exactly as before. Hook commands run via the sandbox (network off) keyed to the
 * execution root.
 */
function preToolUseHook(session: Session): AgentDeps["onPreToolUse"] {
  const hooks = session.config.hooks;
  const list = hooks?.events?.PreToolUse;
  if (!hooks?.enabled || !list || list.length === 0) return undefined;
  const root = session.executionRoot ?? session.config.workspaceRoot;
  return async (toolName, invocation, ctx) => {
    return runPreToolUseHooks(
      list,
      { tool: toolName, command: invocation.command, affectedPaths: invocation.affectedPaths },
      { workspaceRoot: root, sandbox: session.config.sandbox, signal: ctx.signal },
    );
  };
}

export function hookCtx(session: Session): HookRunContext {
  return {
    workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
    sandbox: session.config.sandbox,
  };
}

/** Hooks configured for `event`, or null when hooks are disabled / none configured. */
export function hooksFor(session: Session, event: HookEvent) {
  const hooks = session.config.hooks;
  const list = hooks?.events?.[event];
  if (!hooks?.enabled || !list || list.length === 0) return null;
  return list;
}

/**
 * Build the post-tool advisory hook callback (Phase 7B). PostToolUse fires after
 * a successful tool, PostToolFailure after a failed one; both are advisory.
 */
function postToolHook(session: Session): AgentDeps["onPostTool"] {
  if (!session.config.hooks?.enabled) return undefined;
  if (!hooksFor(session, "PostToolUse") && !hooksFor(session, "PostToolFailure")) return undefined;
  return async (failed, toolName, invocation) => {
    const event: HookEvent = failed ? "PostToolFailure" : "PostToolUse";
    const list = hooksFor(session, event);
    if (!list) return undefined;
    const out = await runAdvisoryHooks(
      event,
      list,
      [toolName, invocation.command],
      { tool: { name: toolName, command: invocation.command } },
      hookCtx(session),
    );
    return out.warnings;
  };
}

/**
 * Phase 8A JIT instruction injector. Returns a callback that, each turn, scans
 * paths read so far and yields rendered path-local instruction blocks for any
 * nested instruction files that just became relevant. `commitJitSource` records
 * each on the graph, so every block is yielded exactly once. Undefined (no-op)
 * when the instruction graph is off.
 */
function jitContext(session: Session): AgentDeps["jitContext"] {
  const graph = session.instructionGraph;
  if (!graph) return undefined;
  return () => {
    const blocks: string[] = [];
    for (const accessed of session.readTracker) {
      for (const src of pathLocalSources(graph, accessed)) {
        blocks.push(commitJitSource(graph, src));
      }
    }
    return blocks;
  };
}

/**
 * Build the skills-activation runtime for a session (Phase 7C2). Shared by the
 * `activate_skill` tool and the `/skills activate` / `/$` slash commands so both
 * paths enforce the same trust/enable/disable rules. The workspace-skill trust
 * prompt uses the interactive `confirm` (non-TTY returns false → refuse).
 */
export function skillsRuntime(session: Session): ActivateSkillRuntime {
  return {
    workspaceRoot: session.config.workspaceRoot,
    skillsConfig: session.config.skills,
    activatedSkills: session.activatedSkills,
    trustedWorkspaceSkills: session.trustedWorkspaceSkills,
    confirmWorkspaceSkill: (p, name) =>
      confirm(
        `Activate workspace skill "${name}" from ${p}?\n` +
          "Skill instructions can influence the model but cannot change permissions.",
      ),
  };
}

/** Fire a session-level advisory event (no matcher keys); returns injected context. */
async function fireSessionEvent(session: Session, event: HookEvent, payload: Record<string, unknown> = {}): Promise<string[]> {
  const list = hooksFor(session, event);
  if (!list) return [];
  const out = await runAdvisoryHooks(event, list, [], payload, hookCtx(session));
  for (const w of out.warnings) stdout.write(chalk.yellow(`\nhook: ${w}\n`));
  return out.context;
}

/**
 * Resolve project instructions for the system prompt. With the Phase 8A
 * instruction graph enabled, this builds the hierarchical graph and returns its
 * rendered startup block (plus the live graph for `/instructions` + JIT);
 * otherwise it falls back to the legacy first-match loader (zero behavior change).
 */
export function resolveInstructions(config: Config): { text: string; graph?: InstructionGraph } {
  if (config.context.instructionGraph) {
    const graph = buildInstructionGraph({
      workspaceRoot: config.workspaceRoot,
      cwd: config.workspaceRoot,
      importsEnabled: config.context.instructionImports,
      importMaxDepth: config.context.instructionImportMaxDepth,
      importMaxBytes: config.context.instructionImportMaxBytes,
    });
    return { text: graph.renderedStartupText, graph };
  }
  return { text: loadInstructions(config.workspaceRoot).text };
}

export function systemMessage(
  config: Config,
  mode: ApprovalMode,
  instructionsText?: string,
  skillsCatalog?: string,
): AgentMessage {
  const text = instructionsText ?? resolveInstructions(config).text;
  // Project memory (8B): the control plane is the real workspace root, so memory
  // persists/loads there even under workspace isolation.
  const memory = loadStartupMemorySync(config.workspaceRoot);
  return {
    role: "system",
    content: buildSystemPrompt({
      workspaceRoot: config.workspaceRoot,
      mode,
      instructions: text,
      solve: config.solve,
      memory,
      skillsCatalog,
    }),
  };
}

/** Synchronous MEMORY.md read for the system prompt (best-effort; "" when none). */
function loadStartupMemorySync(workspaceRoot: string): string {
  try {
    return readFileSync(path.join(workspaceRoot, ".deepcoder", "memory", "MEMORY.md"), "utf8");
  } catch {
    return "";
  }
}

function snapshot(session: Session): SessionSnapshot {
  return {
    provider: session.config.provider,
    baseUrl: session.config.baseUrl,
    model: session.config.model,
    mode: session.mode,
    messages: session.messages,
    todos: session.todos,
    readTracker: session.readTracker,
    writeTracker: session.writeTracker,
    pendingCheckpoint: session.recorder?.serialize() ?? [],
    reviews: session.reviews,
    briefs: session.briefs,
    activatedSkills: session.activatedSkills,
  };
}

/** Injectable UI for a task run (TUI mode). Plain mode passes nothing. */
export interface TaskUi {
  sink: { emit(e: UiEvent): void; endTurn(): void };
  approve: AgentDeps["approve"];
}

export async function runTask(session: Session, ui?: TaskUi): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  // Disable checkpointing during an isolated run: the disposable worktree is
  // itself the undo boundary, and the recorder is keyed to the real root.
  const checkpointing = session.recorder && !session.isolation;
  const ctx: ToolContext = {
    workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
    signal: controller.signal,
    sandbox: session.config.sandbox,
    readTracker: session.readTracker,
    writeTracker: session.writeTracker,
    capturePreImage: checkpointing ? (p) => session.recorder!.capture(p) : undefined,
    recordPostWrite: checkpointing ? (p) => session.recorder!.recordPostWrite(p) : undefined,
    todos: session.todos,
    history: session.messages,
    skills: skillsRuntime(session),
  };

  const renderer = ui?.sink ?? createPlainRenderer({ write: (s) => stdout.write(s) });
  const deps: AgentDeps = {
    provider: session.provider,
    registry: session.registry,
    ctx,
    model: session.config.model,
    mode: session.mode,
    // Phase 7I — post-write diagnostics (no-op unless config.diagnostics.enabled).
    diagnostics: session.config.diagnostics,
    maxTurns: session.config.maxTurns,
    contextBudgetTokens: session.config.contextBudgetTokens,
    compactAt: session.config.compactAt,
    mcpExecuteEnabled: session.config.mcpExecuteEnabled,
    approve: ui?.approve ?? ((inv: ToolInvocation, preview?: ToolPreview) => promptForApproval(inv, preview)),
    onPreToolUse: preToolUseHook(session),
    onPostTool: postToolHook(session),
    jitContext: jitContext(session),
    onPersist: () => session.store.save(snapshot(session)),
    onUsage: (u) => addUsage(session.tokenUsage, u),
    onAssistantTextDelta: (chunk) => renderer.emit({ type: "assistant_delta", text: chunk }),
    onAssistantText: (text) => {
      if (text.trim()) stdout.write("\n" + chalk.bold("assistant> ") + text.trim() + "\n");
    },
    onToolCall: (name, describe) => renderer.emit({ type: "tool_start", name, description: describe }),
    onToolResult: (_name, result: ToolResult) => renderer.emit({ type: "tool_result", name: _name, output: result.output, isError: !!result.isError }),
    onNotice: (m) => renderer.emit({ type: "notice", message: m }),
  };

  let completed = false;
  try {
    await runAgentLoop(session.messages, deps);
    renderer.endTurn();
    completed = true;
  } finally {
    process.removeListener("SIGINT", onSigint);
    // auto mode: finalize a checkpoint even if the run errored or was aborted,
    // so files the agent already wrote always have a rollback point.
    if (!session.isolation && session.config.checkpoints === "auto" && session.recorder && session.recorder.size > 0) {
      try {
        const id = await session.recorder.finalize(completed ? "auto" : "auto:interrupted");
        if (id) {
          const msg = `Checkpoint ${id} saved (${completed ? "auto" : "auto:interrupted"}). /rollback ${id} to undo.`;
          if (ui) renderer.emit({ type: "notice", message: msg });
          else stdout.write(chalk.dim(msg + "\n"));
        }
      } catch {
        /* never mask the original error with a checkpoint failure */
      }
    }
  }
}

/** Non-interactive: run a single task and exit. */
export async function runOneShot(session: Session, prompt: string): Promise<void> {
  try {
    if (session.config.solve) {
      const checkName = session.config.solveCheck;
      const repro = session.config.solveRepro === "auto" ? "auto" : "off";
      if (!checkName && repro !== "auto") {
        stdout.write(chalk.red("--solve requires --check <name> (or DEEPCODER_SOLVE_CHECK), or --repro auto to generate the oracle.\n"));
        return;
      }
      if (session.config.planFirst) await planFirstPass(session, prompt);
      await runSolveCommand(
        session,
        {
          task: prompt,
          checkName,
          maxAttempts: session.config.solveMaxAttempts,
          repro,
          reproPath: session.config.solveReproPath,
        },
        () => runTask(session),
      );
      return;
    }
    if (session.config.planFirst) await planFirstPass(session, prompt);
    session.messages.push({ role: "user", content: prompt });
    await session.store.save(snapshot(session));
    await runTask(session);
  } finally {
    await session.mcp?.closeAll();
  }
}

/**
 * Plan-first pre-pass: ask the reasoner model for a step-by-step plan (no tools,
 * no edits) and record it in history so the editing model can follow it. A plan
 * failure is non-fatal — we fall back to running the task without a plan.
 */
async function planFirstPass(session: Session, prompt: string): Promise<void> {
  const planningModel = session.config.reasonerModel || "deepseek-reasoner";
  stdout.write(chalk.dim(`Planning with ${planningModel}…\n`));
  try {
    const res = await session.provider.chat({
      messages: [
        session.messages[0]!, // current system prompt
        {
          role: "user",
          content:
            "Produce a concrete, step-by-step plan to accomplish the task below. " +
            "Do NOT execute anything or write code — just the plan (files to inspect, the change to make, how to verify):\n\n" +
            prompt,
        },
      ],
      tools: [],
      model: planningModel,
    });
    const plan = res.text.trim();
    if (!plan) return;
    stdout.write("\n" + chalk.dim(plan) + "\n");
    // Record the plan as prior context so the editing model can follow it.
    session.messages.push({ role: "assistant", content: `Plan for the task:\n${plan}` });
    await session.store.save(snapshot(session));
  } catch (err) {
    stdout.write(chalk.yellow(`\nPlanning step failed (${(err as Error).message}); proceeding without a plan.\n`));
  }
}

/** Interactive REPL. */
export async function runRepl(session: Session): Promise<void> {
  stdout.write(
    chalk.bold("deepcoder") +
      chalk.dim(
        ` — ${session.config.model} | mode: ${session.mode} | session: ${session.store.id}\n${session.config.workspaceRoot}\n`,
      ) +
      chalk.dim("Type a task, or /help for commands.\n"),
  );

  // SessionStart hooks (Phase 7B): injected context is appended to the system prompt.
  await injectSessionStartContext(session);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const input = (await rl.question(chalk.cyan("\ndeepcoder> "))).trim();
      if (!input) continue;

      const slash = await handleSlashCommand(input, session, () => session.store.save(snapshot(session)), () =>
        runTask(session),
      );
      if (slash.exit) break;
      if (slash.consumed) {
        // Keep the system prompt in sync if the mode changed.
        session.messages[0] = systemMessage(session.config, session.mode);
        continue;
      }

      // UserPromptSubmit hooks (Phase 7B): may warn and inject context for this turn.
      const extra = await fireSessionEvent(session, "UserPromptSubmit", { prompt: input });
      const content = extra.length ? `${input}\n\n[hook context]\n${extra.join("\n")}` : input;
      session.messages.push({ role: "user", content });
      await session.store.save(snapshot(session));
      try {
        await runTask(session);
      } catch (err) {
        stdout.write(chalk.red(`\nError: ${(err as Error).message ?? err}\n`));
      }
    }
  } finally {
    await fireSessionEvent(session, "SessionEnd");
    rl.close();
    await session.mcp?.closeAll();
  }
}

/** Append SessionStart hook context to the system message (best-effort). */
async function injectSessionStartContext(session: Session): Promise<void> {
  const extra = await fireSessionEvent(session, "SessionStart");
  if (extra.length === 0) return;
  const sys = session.messages[0];
  if (sys?.role === "system") {
    sys.content += `\n\n## Session hook context (non-authoritative)\n${extra.join("\n")}`;
  }
}

/**
 * Phase 10A — minimal raw-mode TUI (experimental, opt-in via --tui). NOT a
 * dependency: hand-rolled alternate-screen + raw input using the tested pure
 * pieces (resolveUiMode gates entry, transcript reducer holds state, renderFrame
 * draws, keyToAction maps keys, createTuiApproval for in-run approvals). This
 * file is the manual-smoke I/O shell; all its logic lives in tested modules.
 *
 * SAFETY: the terminal is ALWAYS restored (raw off, main screen, cursor shown)
 * on every exit path — normal exit, error, signal, or process exit. Slash
 * commands (which print to stdout) SUSPEND the TUI and run on the normal screen.
 */
export async function runTuiRepl(session: Session): Promise<void> {
  const tty = stdin as NodeJS.ReadStream & { setRawMode?(v: boolean): void };
  let transcript: TranscriptState = createTranscript();
  let input = "";
  let viewportTop = 0;
  let atBottom = true;
  let busy = false;
  let approvalResolve: ((k: string) => void) | null = null;
  let restored = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  const enterAlt = () => stdout.write("\x1b[?1049h\x1b[?25l");
  const leaveAlt = () => stdout.write("\x1b[?25h\x1b[?1049l");

  function restore(): void {
    if (restored) return;
    restored = true;
    try { if (tty.isTTY) tty.setRawMode?.(false); } catch { /* best effort */ }
    try { stdin.removeListener("keypress", onKey); } catch { /* */ }
    try { leaveAlt(); } catch { /* */ }
    try { stdin.pause(); } catch { /* */ }
  }

  function flatten(): string[] {
    const out: string[] = [];
    for (const b of transcript.blocks) {
      const prefix =
        b.kind === "assistant" ? "assistant> "
        : b.kind === "user" ? "> "
        : b.kind === "tool" ? `tool ${b.title ?? ""}${b.body ? ": " : ""}`
        : b.kind === "notice" ? "! "
        : "";
      for (const ln of (prefix + (b.body ?? "")).split("\n")) out.push(ln);
    }
    return out;
  }

  const viewportH = () => Math.max(1, (stdout.rows ?? 24) - 2);

  function redraw(): void {
    if (restored) return;
    const lines = flatten();
    const height = viewportH();
    const maxTop = Math.max(0, lines.length - height);
    if (atBottom) viewportTop = maxTop;
    else viewportTop = Math.min(Math.max(0, viewportTop), maxTop);
    const status = `deepcoder · ${session.mode} · ${session.config.provider}/${session.config.model} · sandbox ${session.config.sandbox.mode}${busy ? " · running…" : ""}`;
    const frame = renderFrame({
      statusLine: status, lines, viewportTop, height,
      width: stdout.columns ?? 80, inputLine: "> " + input,
      hasNewOutputBelow: !atBottom && viewportTop < maxTop,
    });
    stdout.write("\x1b[2J\x1b[H" + frame.join("\r\n"));
  }

  const sink = {
    emit: (e: UiEvent) => { transcript = applyEvent(transcript, e); redraw(); },
    endTurn: () => { redraw(); },
  };
  const approval = createTuiApproval({
    nextKey: () => new Promise<string>((res) => { approvalResolve = res; }),
    onRender: (req) => {
      transcript = applyEvent(transcript, { type: "notice", message: `Permission required: ${req.description}  [y] approve · [n] deny` });
      redraw();
    },
  });
  const approve = (inv: ToolInvocation, _preview?: ToolPreview) => approval.approve({ description: inv.describe() });

  function pushUser(line: string): void {
    transcript = { ...transcript, blocks: [...transcript.blocks, { id: `u${Date.now()}`, kind: "user", body: line, startedAt: new Date().toISOString() }] };
  }

  async function submit(): Promise<void> {
    const line = input.trim();
    input = "";
    if (!line) { redraw(); return; }
    pushUser(line); atBottom = true; redraw();
    if (line === "/exit" || line === "/quit") { restore(); resolveDone(); return; }
    if (line.startsWith("/")) {
      restore(); restored = false; // suspend: run the command on the normal screen
      try {
        await handleSlashCommand(line, session, () => session.store.save(snapshot(session)), () => runTask(session));
      } catch (e) { stdout.write(chalk.red(`\nError: ${(e as Error).message ?? e}\n`)); }
      enterAlt();
      if (tty.isTTY) tty.setRawMode?.(true);
      stdin.on("keypress", onKey); stdin.resume();
      redraw();
      return;
    }
    session.messages.push({ role: "user", content: line });
    busy = true; redraw();
    try { await runTask(session, { sink, approve }); }
    catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `Error: ${(e as Error).message ?? e}` }); }
    finally { busy = false; atBottom = true; redraw(); }
  }

  function onKey(str: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean } | undefined): void {
    if (approvalResolve) {
      const r = approvalResolve; approvalResolve = null;
      r(key?.name === "return" ? "enter" : (str ?? key?.sequence ?? key?.name ?? ""));
      return;
    }
    const named = key?.name ? keyToAction(key.name) : "none";
    const action = named !== "none" ? named : keyToAction(key?.sequence ?? str ?? "");
    const lines = flatten().length;
    const maxTop = Math.max(0, lines - viewportH());
    const half = Math.max(1, Math.floor(viewportH() / 2));
    switch (action) {
      case "interrupt":
        if (busy) { try { process.kill(process.pid, "SIGINT"); } catch { /* */ } }
        else { restore(); resolveDone(); }
        return;
      case "scroll-up": atBottom = false; viewportTop = Math.max(0, viewportTop - 1); redraw(); return;
      case "scroll-down": viewportTop = Math.min(maxTop, viewportTop + 1); atBottom = viewportTop >= maxTop; redraw(); return;
      case "half-up": atBottom = false; viewportTop = Math.max(0, viewportTop - half); redraw(); return;
      case "half-down": viewportTop = Math.min(maxTop, viewportTop + half); atBottom = viewportTop >= maxTop; redraw(); return;
      case "top": atBottom = false; viewportTop = 0; redraw(); return;
      case "bottom": atBottom = true; redraw(); return;
      case "escape": atBottom = true; redraw(); return;
      case "submit": if (!busy) void submit(); return;
      default:
        if (busy) return;
        if (key?.name === "backspace") input = input.slice(0, -1);
        else if (str && str.length === 1 && str >= " " && !key?.ctrl) input += str;
        redraw();
    }
  }

  // ── setup (raw mode + alternate screen), with guaranteed restore ──
  enterAlt();
  emitKeypressEvents(stdin);
  if (tty.isTTY) tty.setRawMode?.(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  const onProcExit = () => restore();
  process.on("exit", onProcExit);
  process.on("SIGTERM", onProcExit);
  transcript = applyEvent(transcript, { type: "notice", message: "deepcoder TUI (experimental) — PgUp/PgDn scroll · Enter submit · Ctrl+C exit · /exit quits" });
  redraw();
  try {
    await done;
  } finally {
    restore();
    process.removeListener("exit", onProcExit);
    process.removeListener("SIGTERM", onProcExit);
  }
}
