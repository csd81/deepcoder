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
import { createPrintRenderer } from "../ui/printRenderer.js";
import type { UiEvent } from "../ui/events.js";
import { createTranscript, applyEvent, moveSelection, clearSelection, toggleExpand, selectBlockById, type TranscriptState } from "../ui/transcript.js";
import { renderFrame, keyToAction } from "../ui/minimalRenderer.js";
import { diffFrames } from "../ui/frameWriter.js";
import { wrapLine } from "../ui/textLayout.js";
import { renderMarkdown } from "../ui/markdown.js";
import { solveLayout, flattenLayout, validateLayoutTree, type LayoutNode } from "../ui/layout.js";
import { buildStatusSnapshot } from "../telemetry/statusSnapshot.js";
import { renderStatusline } from "../telemetry/statusline.js";
import { estimateCost } from "../providers/pricing.js";
import { appendWebTrace, type WebTraceRecord } from "../web/trace.js";
import { resolveColorEnabled, createTheme, type Theme } from "../ui/theme.js";
import { createEditor, reduceEditor } from "../ui/inputEditor.js";
import { createTuiApproval } from "../ui/approval.js";
import { renderApprovalModal } from "../ui/approvalModal.js";
import { MOUSE_ENABLE, MOUSE_DISABLE, parseMouseEvent, splitMouseFromChunk } from "../ui/mouse.js";
import { computeFrameRegions, hitTestBlock, type RenderedTranscriptRow } from "../ui/transcriptHitTest.js";
import { renderSlashMenu, completeSelected } from "../ui/slashMenu.js";
import { initChatUi, reduceChatUi, type ChatUiState, type ChatUiAction } from "../ui/chatUiState.js";
import { renderStatusBar, type StatusBarInfo } from "../ui/statusBar.js";
import { Git } from "../workspace/git.js";

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
  /** Phase 10E — auditable web trace (search/fetch citations). Absent until first web call. */
  webTrace?: WebTraceRecord[];
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
    webTrace: session.webTrace,
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

  // Plain-CLI renderer: render finished assistant messages as markdown (with
  // syntax-highlighted code) instead of raw text. Color is on for an interactive
  // terminal (stdout OR stdin is a TTY — npm/tsx can leave stdout.isTTY unset).
  const plainTheme = createTheme(
    resolveColorEnabled({
      env: process.env,
      isTTY: Boolean((stdout as { isTTY?: boolean }).isTTY) || Boolean((stdin as { isTTY?: boolean }).isTTY),
    }),
  );
  const renderer =
    ui?.sink ??
    createPlainRenderer({
      write: (s) => stdout.write(s),
      renderAssistant: (text) => renderMarkdown(text, { width: stdout.columns ?? 80, theme: plainTheme }),
    });
  // Phase 10F: route the main agent turn through the model router's "edit" role.
  // With no role override this resolves to the current model on the current
  // backend (byte-identical) and reuses session.provider; a same-backend model
  // override just swaps the model name, and a different-backend route pulls a
  // pooled provider. Routing never changes tool permissions.
  let provider = session.provider;
  let model = session.config.model;
  if (session.modelRouter && session.providerPool) {
    const route = session.modelRouter.resolve("edit");
    model = route.model;
    const sameBackend =
      route.provider === session.config.provider &&
      (route.baseUrl ?? "") === (session.config.baseUrl ?? "");
    provider = sameBackend ? session.provider : session.providerPool.providerFor(route);
  }
  const deps: AgentDeps = {
    provider,
    registry: session.registry,
    ctx,
    model,
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
    onAssistantText: (text) => renderer.emit({ type: "assistant_delta", text }),
    // Finalize each assistant message so the TUI re-renders it as markdown and
    // the plain CLI flushes its buffered, syntax-highlighted render.
    onAssistantMessageEnd: () => renderer.emit({ type: "assistant_done" }),
    onToolCall: (name, describe) => renderer.emit({ type: "tool_start", name, description: describe }),
    onToolResult: (_name, result: ToolResult) => {
      renderer.emit({ type: "tool_result", name: _name, output: result.output, isError: !!result.isError });
      // Phase 10E: record web tool calls into the auditable, bounded, redacted trace.
      if (_name === "web_fetch" || _name === "web_search") {
        session.webTrace = appendWebTrace(session.webTrace ?? [], {
          id: `wt${(session.webTrace?.length ?? 0) + 1}`,
          kind: _name === "web_fetch" ? "fetch" : "search",
          fetchedAt: new Date().toISOString(),
          blocked: !!result.isError,
          reason: result.isError ? result.output.slice(0, 200) : undefined,
        });
      }
    },
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
export async function runOneShot(
  session: Session,
  prompt: string,
  opts: { print?: boolean } = {},
): Promise<void> {
  // Print mode (`-p`/`--print`): route the turn through a renderer that emits
  // ONLY the raw assistant text — no tool/notice chrome, no markdown, no color —
  // so the reply is clean to capture, pipe, or assert on when testing prompts.
  const ui: TaskUi | undefined = opts.print
    ? {
        sink: createPrintRenderer({ write: (s) => stdout.write(s) }),
        approve: (inv, preview) => promptForApproval(inv, preview),
      }
    : undefined;
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
        () => runTask(session, ui),
      );
      return;
    }
    if (session.config.planFirst) await planFirstPass(session, prompt);
    session.messages.push({ role: "user", content: prompt });
    await session.store.save(snapshot(session));
    await runTask(session, ui);
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
/** Phase 10C — print the one-line status bar after a turn (when enabled). Never throws. */
async function printStatusline(session: Session): Promise<void> {
  if (!session.config.telemetry.statusline) return;
  try {
    const snap = await buildStatusSnapshot({
      provider: session.config.provider,
      model: session.config.model,
      mode: session.mode,
      sandbox: session.config.sandbox.mode,
      sandboxNetwork: (session.config.sandbox.network as "on" | "off" | undefined) ?? "unknown",
      workspaceIsolation: session.config.workspaceIsolation.mode,
      usage: session.tokenUsage,
      cost: estimateCost(session.tokenUsage, {
        provider: session.config.provider,
        model: session.config.model,
        pricing: session.config.telemetry.pricing,
      }),
      mcpWarnings: 0,
      activeSkills: session.activatedSkills?.length ?? 0,
      warnings: [],
    });
    stdout.write(chalk.dim(renderStatusline(snap)) + "\n");
  } catch {
    /* statusline must never break the repl */
  }
}

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
      await printStatusline(session);
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
  let editor = createEditor();
  // Viewport (scroll/atBottom), the slash-command menu, and focus all live in a
  // pure ChatUiState; the shell folds keystrokes/mouse into reduceChatUi actions.
  let chat: ChatUiState = initChatUi({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
  // Git branch/dirty for the status bar — resolved once at startup (cheap), best-effort.
  let branch: string | undefined;
  let dirty = false;
  let busy = false;
  let approvalResolve: ((k: string) => void) | null = null;
  let pendingApproval: { description: string; diff?: string } | null = null;
  let approvalScroll = 0;
  let restored = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  // Last frame written, for diff-based repaint (anti-flicker). Reset to [] whenever
  // the whole screen is invalidated (alt-screen entry, resize) so the next redraw
  // repaints from scratch.
  let prevFrame: string[] = [];

  // Enter the alternate screen, hide the cursor, clear it, and invalidate the diff
  // baseline so the first redraw is a full paint.
  const enterAlt = () => { stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H" + MOUSE_ENABLE); prevFrame = []; };
  const leaveAlt = () => stdout.write("\x1b[?25h\x1b[?1049l");

  function restore(): void {
    if (restored) return;
    restored = true;
    try { if (tty.isTTY) tty.setRawMode?.(false); } catch { /* best effort */ }
    try { stdin.removeListener("keypress", onKey); } catch { /* */ }
    try { stdin.removeListener("data", onStdinData); } catch { /* */ }
    try { stdout.write(MOUSE_DISABLE); } catch { /* */ }
    try { leaveAlt(); } catch { /* */ }
    try { stdin.pause(); } catch { /* */ }
  }

  const theme: Theme = createTheme(
    resolveColorEnabled({
      env: process.env,
      // The TUI is inherently interactive (raw stdin), but npm/tsx can leave
      // stdout.isTTY unset — treat either stream being a TTY as color-capable.
      isTTY: Boolean((stdout as { isTTY?: boolean }).isTTY) || Boolean((stdin as { isTTY?: boolean }).isTTY),
    }),
  );

  /** Logical transcript lines paired with a semantic styler (color applied AFTER wrapping).
   *  `final` lines are already styled + wrapped to `width` (markdown) and must not be re-wrapped.
   *  `meta` carries the originating block so wrapped rows can be hit-tested by the mouse. */
  type StyledLine = { text: string; style: (s: string) => string; final?: boolean; meta?: RenderedTranscriptRow };
  function flattenStyled(width: number): StyledLine[] {
    const out: StyledLine[] = [];
    const sel = transcript.selectedBlockId;
    for (const b of transcript.blocks) {
      const collapsible = b.kind === "tool" || b.kind === "check" || b.kind === "worker";
      if (collapsible) {
        // Collapsible blocks show a one-line header by default; the focused block
        // (Tab cursor) — or one explicitly expanded — also shows its body ("logs").
        const focused = b.id === sel;
        const expanded = focused || b.expanded === true;
        const mark = expanded ? "▾" : "▸";
        const statusMark =
          b.kind === "check" && b.finishedAt ? (b.isError ? " ✗" : " ✓")
          : b.finishedAt ? ""
          : " …";
        const base: (s: string) => string =
          b.kind === "check" ? (b.isError ? theme.error : theme.success)
          : b.kind === "worker" ? (b.isError ? theme.error : (s) => s)
          : theme.dim;
        out.push({
          text: `${mark} ${b.kind} ${b.title ?? ""}${statusMark}`,
          style: focused ? theme.selected : base,
          meta: { text: "", blockId: b.id, kind: b.kind, header: true, collapsible: true },
        });
        if (expanded && b.body) {
          for (const ln of b.body.split("\n")) {
            out.push({ text: "  " + ln, style: theme.dim, meta: { text: "", blockId: b.id, kind: b.kind, header: false, collapsible: true } });
          }
        }
      } else if (b.kind === "assistant" && b.finishedAt !== undefined && b.body) {
        // A completed assistant message is rendered as markdown (headings, code,
        // lists, emphasis). Streaming/unfinished assistant text stays raw below.
        out.push({ text: theme.dim("assistant> "), style: (s) => s, final: true });
        for (const ln of renderMarkdown(b.body, { width, theme })) out.push({ text: ln, style: (s) => s, final: true });
      } else {
        const prefix =
          b.kind === "assistant" ? "assistant> "
          : b.kind === "user" ? "> "
          : b.kind === "notice" ? "! "
          : "";
        const style: (s: string) => string =
          b.kind === "user" ? theme.title
          : b.kind === "notice" ? (b.isError ? theme.warning : theme.dim)
          : b.isError ? theme.error
          : (s) => s;
        for (const ln of (prefix + (b.body ?? "")).split("\n")) out.push({ text: ln, style });
      }
    }
    return out;
  }

  /** Wrap each logical line to width, color each wrapped row, and emit aligned
   *  per-row metadata (every wrapped chunk inherits its source line's block). */
  function buildLinesWithMeta(width: number): { lines: string[]; meta: RenderedTranscriptRow[] } {
    const lines: string[] = [];
    const meta: RenderedTranscriptRow[] = [];
    for (const sl of flattenStyled(width)) {
      const rowMeta: RenderedTranscriptRow = sl.meta ?? { text: "" };
      if (sl.final) { lines.push(sl.text); meta.push({ ...rowMeta, text: sl.text }); } // markdown: pre-wrapped
      else for (const chunk of wrapLine(sl.text, width)) { lines.push(sl.style(chunk)); meta.push({ ...rowMeta, text: chunk }); }
    }
    return { lines, meta };
  }

  /** Wrap each logical line to width, then color each wrapped row (color is zero-width). */
  function buildLines(width: number): string[] {
    return buildLinesWithMeta(width).lines;
  }

  // Last rendered transcript geometry, captured each redraw for mouse hit-testing.
  let lastRowMeta: RenderedTranscriptRow[] = [];
  let lastViewportTop = 0;
  let lastRegions = computeFrameRegions({ height: 1, composerRows: 1 });
  // Rows scrolled per mouse-wheel notch — snappy, a touch faster than the usual 3.
  const MOUSE_WHEEL_ROWS = 4;
  // Set while the fragmented keypresses spawned by a pure-mouse data chunk are
  // draining, so they never land in the composer. Cleared on the next tick.
  let suppressKeys = false;

  /** Apply one fully-formed SGR mouse sequence (wheel scroll / click-to-toggle). */
  function handleMouseSeq(seq: string): void {
    if (restored) return;
    const ev = parseMouseEvent(seq);
    if (!ev) return;
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      const up = ev.kind === "wheel-up";
      if (pendingApproval) {
        // While the approval modal owns the screen, the wheel scrolls the diff.
        approvalScroll = up ? Math.max(0, approvalScroll - MOUSE_WHEEL_ROWS) : approvalScroll + MOUSE_WHEEL_ROWS;
        redraw();
      } else {
        dispatch({ type: up ? "scroll-up" : "scroll-down", amount: MOUSE_WHEEL_ROWS });
      }
      return;
    }
    // Left-click on a collapsible block header focuses + toggles it (keyboard parity).
    if (ev.kind === "left-click" && !pendingApproval && !busy) {
      const frameIdx = ev.row - 1; // mouse rows are 1-based; frame indices 0-based
      if (frameIdx >= lastRegions.transcriptStartRow && frameIdx <= lastRegions.transcriptEndRow) {
        const id = hitTestBlock(lastRowMeta, lastViewportTop, frameIdx - lastRegions.transcriptStartRow);
        if (id) { transcript = toggleExpand(selectBlockById(transcript, id)); redraw(); }
      }
    }
  }

  // Raw stdin reader: SGR mouse sequences arrive intact in a single data chunk
  // (the readline keypress parser, in contrast, fragments them and leaks the
  // digits as keystrokes). Extract+handle every mouse sequence here; if the
  // chunk was *only* mouse data, suppress the keypress fragments it will spawn.
  function onStdinData(buf: Buffer | string): void {
    const s = typeof buf === "string" ? buf : buf.toString("utf8");
    if (!s.includes("\x1b[<")) return; // fast path: no mouse data in this chunk
    const { mouse, rest } = splitMouseFromChunk(s);
    if (mouse.length === 0) return;
    for (const seq of mouse) handleMouseSeq(seq);
    // If only mouse bytes (plus incomplete-sequence noise) remained, drop the
    // keypress fragments readline will emit for this same chunk this tick.
    if (rest.replace(/[\x1b[<;\dMm]/g, "").length === 0) {
      suppressKeys = true;
      setImmediate(() => { suppressKeys = false; });
    }
  }

  /** The input composer rendered as display rows (continuation lines indented). */
  function composerLines(): string[] {
    const buf = editor.text.length ? editor.text.split("\n") : [""];
    return buf.map((l, i) => (i === 0 ? "> " : "  ") + l);
  }

  // Window height = rows minus status(1) + indicator-reserve(1) + composer rows,
  // so the absolutely-positioned diff frame never overflows the screen. The region
  // split is expressed as a column layout solved by the ui/layout engine: a fixed
  // status row + indicator row + composer (inputCount rows) with the transcript
  // window taking the remaining grow space. The solved transcript height equals
  // rows-2-inputCount, identical to the prior hand arithmetic, clamped to >=1.
  const viewportH = (inputCount = 1, menuCount = 0): number => {
    const tree: LayoutNode = {
      id: "tui-root",
      direction: "column",
      children: [
        { id: "status", fixedHeight: 1 },
        { id: "transcript", grow: 1 },
        { id: "indicator", fixedHeight: 1 },
        { id: "menu", fixedHeight: Math.max(0, menuCount) },
        { id: "composer", fixedHeight: Math.max(0, inputCount) },
      ],
    };
    validateLayoutTree(tree);
    const boxes = flattenLayout(
      solveLayout(tree, { width: stdout.columns ?? 80, height: stdout.rows ?? 24 }),
    );
    return Math.max(1, boxes.get("transcript")?.h ?? 0);
  };

  /** Slash dropdown rows (empty when the menu is closed). */
  function menuRows(width: number): string[] {
    return chat.slashMenu.open ? renderSlashMenu(chat.slashMenu, width, theme) : [];
  }

  /** Largest valid transcript scroll offset for the current content + window. */
  function transcriptMaxTop(): number {
    const width = stdout.columns ?? 80;
    const vh = viewportH(composerLines().length, menuRows(width).length);
    return Math.max(0, buildLines(width).length - vh);
  }

  /** Apply a ChatUiState action with the current maxTop, then repaint. */
  function dispatch(action: ChatUiAction): void {
    chat = reduceChatUi(chat, action, { maxTop: transcriptMaxTop() });
    redraw();
  }

  /** Re-pin the view to the bottom (does not repaint). */
  function stickBottom(): void {
    chat = reduceChatUi(chat, { type: "scroll-bottom" }, { maxTop: transcriptMaxTop() });
  }

  /** Recompute the slash menu from the current composer text (does not repaint). */
  function syncMenu(): void {
    chat = reduceChatUi(chat, { type: "input-changed", text: editor.text }, { maxTop: transcriptMaxTop() });
  }

  function redraw(): void {
    if (restored) return;
    const width = stdout.columns ?? 80;
    // Wrap logical lines to the terminal width so nothing is truncated off-screen
    // and a resize re-wraps cleanly. renderFrame's own (ANSI-aware) truncate no-ops.
    const composer = composerLines();
    // The slash dropdown is suppressed while an approval modal owns the screen.
    const menu = pendingApproval ? [] : menuRows(width);
    const height = viewportH(composer.length, menu.length);
    // While an approval is pending, the content window IS the modal (diff overlay).
    const built = pendingApproval ? null : buildLinesWithMeta(width);
    const lines = built
      ? built.lines
      : renderApprovalModal({ description: pendingApproval!.description, diff: pendingApproval!.diff, width, height, scroll: approvalScroll, theme });
    const maxTop = Math.max(0, lines.length - height);
    // Derive the display offset from chat state without mutating it: an approval
    // pins to top, a bottom-stuck view snaps to maxTop, else clamp the saved top.
    const viewportTop = pendingApproval ? 0 : chat.atBottom ? maxTop : Math.min(Math.max(0, chat.viewportTop), maxTop);
    const hasNewOutputBelow = !pendingApproval && !chat.atBottom && viewportTop < maxTop;
    // Capture geometry for mouse hit-testing (only meaningful for the transcript).
    lastRowMeta = built ? built.meta : [];
    lastViewportTop = viewportTop;
    lastRegions = computeFrameRegions({ height, composerRows: composer.length, hasIndicator: hasNewOutputBelow, menuRows: menu.length });
    const usage = session.tokenUsage;
    const cost = session.telemetry?.estimatedCost;
    const info: StatusBarInfo = {
      mode: session.mode,
      provider: session.config.provider,
      model: session.config.model,
      sandbox: session.config.sandbox.mode,
      web: session.config.web.enabled,
      branch,
      dirty,
      tokens: usage.totalTokens > 0 ? usage.totalTokens : undefined,
      costUsd: cost?.pricingKnown ? cost.totalUsd : undefined,
      busy,
    };
    const status = renderStatusBar(info, width, theme);
    const frame = renderFrame({
      statusLine: status, lines, viewportTop, height,
      width, inputLine: composer[0], inputLines: composer,
      hasNewOutputBelow,
      menuLines: menu.length ? menu : undefined,
    });
    // Repaint only the lines that changed since the last frame (anti-flicker).
    const ops = diffFrames(prevFrame, frame);
    if (ops) stdout.write(ops);
    prevFrame = frame;
  }

  // Terminal was resized: the alt screen reflowed, so clear and repaint from
  // scratch at the new dimensions (flatten + wrapLines pick up the new width).
  function onResize(): void {
    if (restored) return;
    chat = reduceChatUi(chat, { type: "resize", width: stdout.columns ?? 80, height: stdout.rows ?? 24 }, { maxTop: transcriptMaxTop() });
    stdout.write("\x1b[2J\x1b[H");
    prevFrame = [];
    redraw();
  }

  const sink = {
    emit: (e: UiEvent) => { transcript = applyEvent(transcript, e); redraw(); },
    endTurn: () => { redraw(); },
  };
  const approval = createTuiApproval({
    nextKey: () => new Promise<string>((res) => { approvalResolve = res; }),
    onRender: (req) => { pendingApproval = { description: req.description, diff: req.diff }; approvalScroll = 0; stickBottom(); redraw(); },
  });
  const approve = async (inv: ToolInvocation, preview?: ToolPreview): Promise<boolean> => {
    const ok = await approval.approve({ description: inv.describe(), diff: preview?.diff });
    pendingApproval = null;
    redraw();
    return ok;
  };

  function pushUser(line: string): void {
    transcript = { ...transcript, blocks: [...transcript.blocks, { id: `u${Date.now()}`, kind: "user", body: line, startedAt: new Date().toISOString() }] };
  }

  async function handleSubmit(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) { redraw(); return; }
    pushUser(line); stickBottom(); redraw();
    if (line === "/exit" || line === "/quit") { restore(); resolveDone(); return; }
    if (line.startsWith("/")) {
      restore(); restored = false; // suspend: run the command on the normal screen
      try {
        await handleSlashCommand(line, session, () => session.store.save(snapshot(session)), () => runTask(session));
      } catch (e) { stdout.write(chalk.red(`\nError: ${(e as Error).message ?? e}\n`)); }
      enterAlt();
      if (tty.isTTY) tty.setRawMode?.(true);
      stdin.on("data", onStdinData);
      stdin.on("keypress", onKey); stdin.resume();
      redraw();
      return;
    }
    session.messages.push({ role: "user", content: line });
    busy = true; redraw();
    try { await runTask(session, { sink, approve }); }
    catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `Error: ${(e as Error).message ?? e}` }); }
    finally { busy = false; stickBottom(); redraw(); }
  }

  function onKey(str: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean } | undefined): void {
    // Mouse is parsed from the raw stdin stream (see onStdinData) because the
    // readline keypress parser fragments SGR mouse sequences and leaks the
    // digits as keystrokes. Drop anything left over from a mouse chunk: the
    // suppress window covers the fragmented keypresses, and a stray "\x1b[<"
    // prefix is swallowed defensively.
    if (suppressKeys) return;
    const rawSeq = key?.sequence ?? str ?? "";
    if (rawSeq.startsWith("\x1b[<")) return;
    if (approvalResolve) {
      // ↑/↓ (and PgUp/PgDn) scroll the diff without resolving; y/n/Esc resolve.
      const a = key?.name ? keyToAction(key.name) : keyToAction(key?.sequence ?? str ?? "");
      if (a === "history-up" || a === "scroll-up" || a === "half-up") { approvalScroll = Math.max(0, approvalScroll - 1); redraw(); return; }
      if (a === "history-down" || a === "scroll-down" || a === "half-down") { approvalScroll += 1; redraw(); return; }
      const r = approvalResolve; approvalResolve = null;
      r(key?.name === "escape" ? "escape" : (str ?? key?.sequence ?? key?.name ?? ""));
      return;
    }
    // Alt/Meta + Enter inserts a newline instead of submitting (multiline compose).
    if (key?.name === "return" && (key as { meta?: boolean }).meta) {
      if (!busy) { editor = reduceEditor(editor, { type: "newline" }).state; syncMenu(); redraw(); }
      return;
    }
    // Tab: complete the highlighted slash command when the menu is open; otherwise
    // step the focus cursor across collapsible blocks (expanding the focused one).
    if (key?.name === "tab") {
      if (busy) return;
      if (chat.slashMenu.open) {
        const completed = completeSelected(chat.slashMenu);
        if (completed !== null) { editor = { ...editor, text: completed, cursor: completed.length }; syncMenu(); redraw(); }
        return;
      }
      transcript = moveSelection(transcript, (key as { shift?: boolean }).shift ? -1 : 1);
      stickBottom();
      redraw();
      return;
    }
    const named = key?.name ? keyToAction(key.name) : "none";
    const action = named !== "none" ? named : keyToAction(key?.sequence ?? str ?? "");
    const inputCount = composerLines().length;
    const half = Math.max(1, Math.floor(viewportH(inputCount, menuRows(stdout.columns ?? 80).length) / 2));
    switch (action) {
      case "interrupt":
        if (busy) { try { process.kill(process.pid, "SIGINT"); } catch { /* */ } }
        else { restore(); resolveDone(); }
        return;
      case "scroll-up": dispatch({ type: "scroll-up" }); return;
      case "scroll-down": dispatch({ type: "scroll-down" }); return;
      case "half-up": dispatch({ type: "scroll-up", amount: half }); return;
      case "half-down": dispatch({ type: "scroll-down", amount: half }); return;
      case "top": dispatch({ type: "scroll-top" }); return;
      case "bottom": dispatch({ type: "scroll-bottom" }); return;
      // ↑/↓ navigate the slash menu while it is open; otherwise step input history.
      case "history-up":
        if (busy) return;
        if (chat.slashMenu.open) { chat = reduceChatUi(chat, { type: "menu-up" }, { maxTop: 0 }); redraw(); return; }
        editor = reduceEditor(editor, { type: "history-prev" }).state; syncMenu(); redraw(); return;
      case "history-down":
        if (busy) return;
        if (chat.slashMenu.open) { chat = reduceChatUi(chat, { type: "menu-down" }, { maxTop: 0 }); redraw(); return; }
        editor = reduceEditor(editor, { type: "history-next" }).state; syncMenu(); redraw(); return;
      case "escape":
        // Esc closes the slash menu first; otherwise clears block selection.
        if (chat.slashMenu.open) { chat = reduceChatUi(chat, { type: "menu-close" }, { maxTop: 0 }); redraw(); return; }
        transcript = clearSelection(transcript); stickBottom(); redraw(); return;
      case "submit": {
        if (busy) return;
        // First Enter with the menu open completes the highlighted command (a
        // trailing space closes the menu); a second Enter then submits.
        if (chat.slashMenu.open) {
          const completed = completeSelected(chat.slashMenu);
          if (completed !== null && completed.trim() !== editor.text.trim()) {
            editor = { ...editor, text: completed, cursor: completed.length }; syncMenu(); redraw(); return;
          }
        }
        const { state, submitted } = reduceEditor(editor, { type: "submit" });
        editor = state;
        chat = reduceChatUi(chat, { type: "submit" }, { maxTop: transcriptMaxTop() });
        if (submitted !== undefined) void handleSubmit(submitted);
        return;
      }
      default:
        if (busy) return;
        if (key?.name === "backspace") editor = reduceEditor(editor, { type: "backspace" }).state;
        else if (str && str.length === 1 && str >= " " && !key?.ctrl) editor = reduceEditor(editor, { type: "insert", ch: str }).state;
        syncMenu();
        redraw();
    }
  }

  // ── setup (raw mode + alternate screen), with guaranteed restore ──
  enterAlt();
  // Raw mouse reader runs BEFORE emitKeypressEvents so it sees each data chunk
  // first and can suppress the keypress fragments a mouse sequence would spawn.
  stdin.on("data", onStdinData);
  emitKeypressEvents(stdin);
  if (tty.isTTY) tty.setRawMode?.(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  const onProcExit = () => restore();
  process.on("exit", onProcExit);
  process.on("SIGTERM", onProcExit);
  stdout.on("resize", onResize);
  transcript = applyEvent(transcript, { type: "notice", message: "deepcoder TUI (experimental) — type / for commands · mouse-wheel/PgUp/PgDn scroll · Tab inspect tool output · ↑/↓ history · Alt+Enter newline · Enter submit · Esc collapse · Ctrl+C exit · /exit quits" });
  // Resolve the git branch/dirty flag once for the status bar (best-effort, async).
  void (async () => {
    try {
      const git = new Git(session.executionRoot ?? session.config.workspaceRoot);
      if (await git.isRepo()) {
        const sb = await git.status();
        const head = sb.split("\n")[0] ?? "";
        const m = /^##\s+(?:No commits yet on\s+)?([^.\s]+)/.exec(head);
        if (m) branch = m[1];
        dirty = sb.split("\n").slice(1).some((l) => l.trim().length > 0);
        redraw();
      }
    } catch { /* status bar simply omits the branch */ }
  })();
  redraw();
  try {
    await done;
  } finally {
    restore();
    stdout.removeListener("resize", onResize);
    process.removeListener("exit", onProcExit);
    process.removeListener("SIGTERM", onProcExit);
  }
}
