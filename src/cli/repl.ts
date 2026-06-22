import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { effectiveMaxTurns, type ApprovalMode, type Config } from "../config/config.js";
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
import { classifyCommand } from "../permissions/commandClassifier.js";
import { runBashTool } from "../tools/runBash.js";
import { parseBangCommand, decideBang } from "./bangCommand.js";
import type { ActivateSkillRuntime } from "../skills/activation.js";
import { handleSlashCommand } from "./slashCommands.js";
import { slashNeedsSuspend } from "./tuiSlashRouting.js";
import { runSolveCommand } from "./solveRunner.js";
import { proposeMemory } from "../memory/store.js";
import { SessionStore, type SessionSnapshot } from "../session/sessionStore.js";
import type { McpManager } from "../mcp/registry.js";
import type { LspRuntime } from "../lsp/types.js";
import { CheckpointRecorder } from "../session/checkpoints.js";
import type { SubagentRunRecord } from "../subagents/types.js";
import type { BriefRunRecord } from "../context/explorerBrief.js";
import type { ModelRouter } from "../models/router.js";
import type { ProviderPool } from "../models/providerPool.js";
import { buildDelegateRuntime, attachFileWatcher } from "../runtime/sessionFactory.js";
import { createPlainRenderer } from "../ui/plainRenderer.js";
import { createPrintRenderer } from "../ui/printRenderer.js";
import type { UiEvent } from "../ui/events.js";
import { createTranscript, applyEvent, moveSelection, clearSelection, toggleExpand, selectBlockById, type TranscriptState } from "../ui/transcript.js";
import { renderFrame, keyToAction } from "../ui/minimalRenderer.js";
import { actionForKey } from "../ui/keybinds.js";
import { initState, pushTurn, type UndoRedoState, type UndoEntry } from "./undoRedo.js";
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
import { createInputQueue, enqueue, dequeue, queueDepth, decideSubmit, type InputQueue } from "./inputQueue.js";
import { createTuiApproval } from "../ui/approval.js";
import { buildApprovalReview, renderApprovalReview } from "../ui/approvalReview.js";
import { renderHelpOverlay, type HelpMode } from "../ui/helpOverlay.js";
import { renderFooterHints, type FooterHintMode } from "../ui/footerHints.js";
import { createNamedTheme, listThemeNames, isValidThemeName, type ThemeName } from "../ui/themes.js";
import { buildBlockPreview } from "../ui/blockPreview.js";
import { createSearchState, updateSearch, moveSearchSelection, selectedMatch, type TranscriptSearchState } from "../ui/transcriptSearch.js";
import { formatTranscriptBlockMarkdown, selectedBlock } from "../ui/transcriptExport.js";
import { safeExportFilename } from "../ui/exportWriter.js";
import { copyToClipboard } from "../clipboard/clipboard.js";
import { MOUSE_ENABLE, MOUSE_DISABLE, mouseStatusNotice, parseMouseEvent, splitMouseFromChunk } from "../ui/mouse.js";
import { computeFrameRegions, hitTestBlock, type RenderedTranscriptRow } from "../ui/transcriptHitTest.js";
import { renderSlashMenu, completeSelected } from "../ui/slashMenu.js";
import {
  buildFileIndex,
  queryFiles,
  renderCompleterDropdown,
  type FileIndex,
} from "../ui/fileCompleter.js";
import { initChatUi, reduceChatUi, type ChatUiState, type ChatUiAction } from "../ui/chatUiState.js";
import { renderStatusBar, type StatusBarInfo } from "../ui/statusBar.js";
import { createActivityTimeline, applyActivityEvent, renderActivityTimeline, type ActivityTimelineState } from "../ui/activityTimeline.js";
import { renderAssistantBlock } from "../ui/assistantRenderState.js";
import { renderEmptyState } from "../ui/emptyState.js";
import { createStyleTokens } from "../ui/styleTokens.js";
import { Git } from "../workspace/git.js";
import type { FileWatcher } from "../workspace/fileWatcher.js";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import { expandMentions } from "./atMention.js";
import { forkSide, returnToMain, type SideState } from "./sideConversation.js";
import {
  initPlanMode,
  recordPlan,
  approvePlan,
  rejectPlan,
  exitPlanMode,
  effectivePlanModeApproval,
  type PlanModeState,
} from "./planMode.js";

/** Debounce map for auto-memory: only stage a candidate if the last proposal
 *  for a given source was more than 60s ago. Module-level so it persists
 *  across turns in both REPL and one-shot modes. */
const lastProposal = new Map<string, number>();

/** Mutable runtime state for one interactive (or one-shot) session. */
export interface Session {
  config: Config;
  /** True for an interactive REPL/TUI session (human present, can Ctrl-C) — lifts
   *  the per-task turn cap so a plan implementation doesn't abort mid-flight. */
  interactive?: boolean;
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
  /** LSP runtime (lazy servers per language); undefined when LSP is disabled. */
  lsp?: LspRuntime;
  /** Per-turn undo/redo stack (rides the checkpoint blob store). */
  undoState?: UndoRedoState;
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
  /** Interactive Plan Mode state — undefined means inactive (/plan-mode off). */
  planState?: PlanModeState;
  /** Human-readable session label, set via /title or --title. */
  title?: string;
  /** When true, renderers strip ANSI escape codes from all output. */
  rawMode?: boolean;
  /** File-change watcher (detects external edits). Started on session build,
   *  stopped on session teardown. Passive — never interrupts a turn. */
  fileWatcher?: FileWatcher;
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
  toolNames?: string[],
): AgentMessage {
  // A/B override (Slice D): when DEEPCODER_SYSTEM_PROMPT_FILE points at a
  // readable file, swap the WHOLE system message content with its contents so
  // an alternate prompt can be tested on the same battery.
  const override = loadSystemPromptOverride();
  if (override !== null) {
    return { role: "system", content: override };
  }
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
      toolNames,
    }),
  };
}

/**
 * A/B experimentation knob (Slice D): if DEEPCODER_SYSTEM_PROMPT_FILE is set,
 * return that file's contents to fully override the system message; otherwise
 * (unset/empty/unreadable) return null and never throw.
 */
export function loadSystemPromptOverride(): string | null {
  const file = process.env.DEEPCODER_SYSTEM_PROMPT_FILE;
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
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
    title: session.title,
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
    delegate: buildDelegateRuntime(session),
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
      raw: session.rawMode,
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
    mode: effectivePlanModeApproval(session.planState ?? initPlanMode(), session.mode),
    // Phase 7I — post-write diagnostics (no-op unless config.diagnostics.enabled).
    diagnostics: session.config.diagnostics,
    // Format-on-edit (null when not configured).
    format: session.config.format,
    maxTurns: effectiveMaxTurns({
      configMaxTurns: session.config.maxTurns,
      interactive: session.interactive === true,
      envExplicit: (process.env.DEEPCODER_MAX_TURNS ?? "") !== "",
    }),
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
        // Record this turn's edits as an undo entry BEFORE finalize clears the
        // window (the pre-image blobs are already in the checkpoint blob store).
        const lastUser = [...session.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
        const files = session.recorder.serialize()
          .filter((e) => e.expectedSha !== undefined)
          .map((e): UndoEntry["files"][number] => ({ path: e.path, existed: e.existed, restoreSha: e.restoreSha ?? null }));
        const id = await session.recorder.finalize(completed ? "auto" : "auto:interrupted");
        if (files.length > 0) {
          const label = (typeof lastUser?.content === "string" ? lastUser.content : "").slice(0, 60) || "turn";
          session.undoState = pushTurn(session.undoState ?? initState(), { label, files });
        }
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

  // Proactive auto-memory (Phase 8B follow-up): after a successful turn that
  // changed files, stage a candidate learning for human review.
  // Best-effort; never breaks the agent loop.
  if (completed && session.writeTracker.size > 0) {
    const now = Date.now();
    if (!lastProposal.get("agent-turn") || now - lastProposal.get("agent-turn")! >= 60_000) {
      lastProposal.set("agent-turn", now);
      const changed = [...session.writeTracker].map((p) => path.basename(p));
      const lastMsg = session.messages.at(-1);
      const taskHint =
        (typeof lastMsg?.content === "string" ? lastMsg.content : "")
          .replace(/\s+/g, " ").trim().slice(0, 100) || "agent turn";
      try {
        const staged = await proposeMemory(
          session.config.workspaceRoot,
          `Edited ${changed.join(", ")} (task: ${taskHint}).`,
          "agent-loop",
        );
        if (staged.ok) {
          const msg = "memory: staged 1 candidate — review with /memory inbox";
          if (ui) renderer.emit({ type: "notice", message: msg });
          else stdout.write(chalk.dim(msg + "\n"));
        }
      } catch {
        /* auto-memory is best-effort */
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
    const root = session.executionRoot ?? session.config.workspaceRoot;
    const exp = expandMentions(prompt, { resolve: (p) => resolveReadPathInWorkspace(root, p), readFile: (p) => readFileSync(p, "utf8") });
    for (const s of exp.skipped) stdout.write(chalk.dim(`@${s.path}: ${s.reason}\n`));
    session.messages.push({ role: "user", content: exp.prompt });
    await session.store.save(snapshot(session));
    await runTask(session, ui);
  } finally {
    session.fileWatcher?.stop();
    await session.mcp?.closeAll();
    await session.lsp?.closeAll();
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
    const rawIndicator = session.rawMode ? " [raw]" : "";
    stdout.write(chalk.dim(renderStatusline(snap)) + rawIndicator + "\n");
  } catch {
    /* statusline must never break the repl */
  }
}

/**
 * Phase 10R — run a user-typed `!command` through the same sandboxed, redacted,
 * timeout-bounded path as the model's run_bash tool, returning its output.
 */
async function executeBang(session: Session, command: string, signal: AbortSignal): Promise<{ output: string; isError?: boolean }> {
  const ctx: ToolContext = {
    workspaceRoot: session.executionRoot ?? session.config.workspaceRoot,
    signal,
    sandbox: session.config.sandbox,
    readTracker: session.readTracker,
    writeTracker: session.writeTracker,
    todos: session.todos,
  };
  const res = await runBashTool.build({ command }).execute(ctx);
  return { output: res.output, isError: res.isError };
}

export async function runRepl(session: Session): Promise<void> {
  session.interactive = true; // human present → generous turn cap (see effectiveMaxTurns)
  attachFileWatcher(session); // interactive only — stopped on exit below
  stdout.write(
    chalk.bold("deepcoder") +
      chalk.dim(
        ` — ${session.config.model} | mode: ${session.mode}${session.rawMode ? " | raw" : ""} | session: ${session.store.id}\n${session.config.workspaceRoot}\n`,
      ) +
      chalk.dim("Type a task, /help for commands, or !<cmd> to run a shell command.\n"),
  );

  // SessionStart hooks (Phase 7B): injected context is appended to the system prompt.
  await injectSessionStartContext(session);

  let sideState: SideState | null = null;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const input = (await rl.question(chalk.cyan("\ndeepcoder> "))).trim();
      if (!input) continue;

      // ── Side conversation: return to main ──
      if (input === "/main" || input === "/back") {
        if (!sideState) {
          stdout.write(chalk.dim("Not in a side conversation.\n"));
          continue;
        }
        const restored = returnToMain(sideState);
        session.messages = restored.messages;
        session.readTracker = restored.readTracker;
        session.writeTracker = restored.writeTracker;
        sideState = null;
        stdout.write(chalk.dim("Returned to main thread.\n"));
        continue;
      }

      // ── Side conversation: fork on /side or /btw ──
      const sideMatch = input.match(/^\/(side|btw)\s*(.*)/);
      if (sideMatch) {
        const question = sideMatch[2]!.trim();
        sideState = forkSide(sideState, session.messages, session.readTracker, session.writeTracker);
        if (question) {
          // Single-turn: push question, run via temporary swap, return to main.
          sideState.sideMessages.push({ role: "user", content: question });
          const savedMessages = session.messages;
          const savedRead = session.readTracker;
          const savedWrite = session.writeTracker;
          session.messages = sideState.sideMessages;
          session.readTracker = sideState.mainReadTracker;
          session.writeTracker = sideState.mainWriteTracker;
          try {
            await runTask(session);
          } catch (e) {
            stdout.write(chalk.red(`\n[side] Error: ${(e as Error).message ?? e}\n`));
          }
          // Capture the updated side messages; restore main thread state.
          sideState.sideMessages = session.messages;
          session.messages = savedMessages;
          session.readTracker = savedRead;
          session.writeTracker = savedWrite;
          const restored = returnToMain(sideState);
          session.messages = restored.messages;
          session.readTracker = restored.readTracker;
          session.writeTracker = restored.writeTracker;
          sideState = null;
        }
        // else: multi-turn mode — stays in side until /main or /back
        continue;
      }

      // ── Side conversation: active — route user input to side messages ──
      if (sideState) {
        // Allow ! commands in side context (runs on the session's workspace)
        const bang = parseBangCommand(input);
        if (bang !== null) {
          if (bang === "") { stdout.write(chalk.dim("Usage: !<command> — run a shell command, e.g. !ls -la\n")); continue; }
          const decision = decideBang(bang, session.mode, classifyCommand);
          if (decision.action === "refuse") { stdout.write(chalk.yellow(`Refused: ${decision.reason}.\n`)); continue; }
          if (decision.action === "confirm" && !(await confirm(`Run flagged-dangerous command?  $ ${bang}`))) {
            stdout.write(chalk.dim("Cancelled.\n")); continue;
          }
          const controller = new AbortController();
          const onSig = () => controller.abort();
          process.once("SIGINT", onSig);
          try {
            const { output, isError } = await executeBang(session, bang, controller.signal);
            stdout.write((isError ? chalk.red(output) : output).replace(/\n*$/, "\n"));
          } catch (e) { stdout.write(chalk.red(`Error: ${(e as Error).message ?? e}\n`)); }
          finally { process.removeListener("SIGINT", onSig); }
          continue;
        }
        sideState.sideMessages.push({ role: "user", content: input });
        const savedMessages = session.messages;
        const savedRead = session.readTracker;
        const savedWrite = session.writeTracker;
        session.messages = sideState.sideMessages;
        session.readTracker = sideState.mainReadTracker;
        session.writeTracker = sideState.mainWriteTracker;
        try {
          await runTask(session);
        } catch (e) {
          stdout.write(chalk.red(`\n[side] Error: ${(e as Error).message ?? e}\n`));
        }
        sideState.sideMessages = session.messages;
        session.messages = savedMessages;
        session.readTracker = savedRead;
        session.writeTracker = savedWrite;
        continue;
      }

      // Phase 10R: `!cmd` shell-escape — runs a real shell command, never the model.
      const bang = parseBangCommand(input);
      if (bang !== null) {
        if (bang === "") { stdout.write(chalk.dim("Usage: !<command> — run a shell command, e.g. !ls -la\n")); continue; }
        const decision = decideBang(bang, session.mode, classifyCommand);
        if (decision.action === "refuse") { stdout.write(chalk.yellow(`Refused: ${decision.reason}.\n`)); continue; }
        if (decision.action === "confirm" && !(await confirm(`Run flagged-dangerous command?  $ ${bang}`))) {
          stdout.write(chalk.dim("Cancelled.\n")); continue;
        }
        const controller = new AbortController();
        const onSig = () => controller.abort();
        process.once("SIGINT", onSig);
        try {
          const { output, isError } = await executeBang(session, bang, controller.signal);
          stdout.write((isError ? chalk.red(output) : output).replace(/\n*$/, "\n"));
        } catch (e) { stdout.write(chalk.red(`Error: ${(e as Error).message ?? e}\n`)); }
        finally { process.removeListener("SIGINT", onSig); }
        continue;
      }

      const slash = await handleSlashCommand(input, session, () => session.store.save(snapshot(session)), () =>
        runTask(session),
      );
      if (slash.exit) break;
      if (slash.consumed) {
        // Keep the system prompt in sync if the mode changed.
        session.messages[0] = systemMessage(session.config, session.mode, undefined, undefined, session.registry.names());
        continue;
      }

      // UserPromptSubmit hooks (Phase 7B): may warn and inject context for this turn.
      const extra = await fireSessionEvent(session, "UserPromptSubmit", { prompt: input });
      const content = extra.length ? `${input}\n\n[hook context]\n${extra.join("\n")}` : input;
      // Expand @-file mentions before submitting.
      const root = session.executionRoot ?? session.config.workspaceRoot;
      const exp = expandMentions(content, { resolve: (p) => resolveReadPathInWorkspace(root, p), readFile: (p) => readFileSync(p, "utf8") });
      for (const s of exp.skipped) stdout.write(chalk.dim(`@${s.path}: ${s.reason}\n`));
      session.messages.push({ role: "user", content: exp.prompt });
      await session.store.save(snapshot(session));
      try {
        await runTask(session);
      } catch (err) {
        stdout.write(chalk.red(`\nError: ${(err as Error).message ?? err}\n`));
      }

      // Interactive Plan Mode: after an investigating turn, the assistant's final
      // text is the proposed plan. Prompt the user to approve or reject it.
      if ((session.planState ?? initPlanMode()).phase === "investigating") {
        const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0);
        if (lastAssistant && typeof lastAssistant.content === "string") {
          const planState = session.planState ?? initPlanMode();
          session.planState = recordPlan(planState, lastAssistant.content);
          const approved = await confirm(chalk.bold("Execute this plan?"));
          if (approved) {
            session.planState = approvePlan(session.planState);
            session.messages.push({ role: "user", content: `Execute this plan:\n${lastAssistant.content}` });
            await session.store.save(snapshot(session));
            try {
              await runTask(session);
            } catch (err) {
              stdout.write(chalk.red(`\nError: ${(err as Error).message ?? err}\n`));
            }
            session.planState = exitPlanMode(session.planState);
          } else {
            session.planState = rejectPlan(session.planState);
            stdout.write(chalk.dim("Plan rejected. Staying in read-only investigation mode.\n"));
          }
        }
      }

      await printStatusline(session);
    }
  } finally {
    session.fileWatcher?.stop();
    await fireSessionEvent(session, "SessionEnd");
    rl.close();
    await session.mcp?.closeAll();
    await session.lsp?.closeAll();
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
  session.interactive = true; // human present → generous turn cap (see effectiveMaxTurns)
  attachFileWatcher(session); // interactive only — stopped on exit below
  const tty = stdin as NodeJS.ReadStream & { setRawMode?(v: boolean): void };
  let transcript: TranscriptState = createTranscript();
  let editor = createEditor();
  // Resume: replay the restored conversation into the transcript and seed the
  // input history, so a resumed session shows its prior turns and ↑ recalls them.
  {
    const resumedBlocks = session.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m, i) => ({
        id: `r${i}`,
        kind: m.role as "user" | "assistant",
        body: m.content,
        startedAt: new Date(0).toISOString(),
        ...(m.role === "assistant" ? { finishedAt: new Date(0).toISOString() } : {}),
      }));
    if (resumedBlocks.length > 0) transcript = { ...transcript, blocks: resumedBlocks };
    const hist = session.messages
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => m.content);
    if (hist.length > 0) editor = { ...editor, history: hist, histPos: hist.length };
  }
  // Viewport (scroll/atBottom), the slash-command menu, and focus all live in a
  // pure ChatUiState; the shell folds keystrokes/mouse into reduceChatUi actions.
  let chat: ChatUiState = initChatUi({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });

  // ── File completer (local state, like search/approval) ──
  interface FileCompleterState {
    active: boolean;
    prefix: string;
    matches: string[];
    selected: number;
    cursorPos: number;
  }
  let fileIndex: FileIndex | null = null;
  let fileCompleter: FileCompleterState = {
    active: false,
    prefix: "",
    matches: [],
    selected: 0,
    cursorPos: 0,
  };
  // Git branch/dirty for the status bar — resolved once at startup (cheap), best-effort.
  let branch: string | undefined;
  let dirty = false;
  let busy = false;
  let queue: InputQueue = createInputQueue();
  let sideState: SideState | null = null;
  let approvalResolve: ((k: string) => void) | null = null;
  let pendingApproval: { description: string; diff?: string } | null = null;
  let approvalScroll = 0;
  let approvalReviewMode: "diff" | "details" = "diff"; // 10A.20: `d` toggles
  let restored = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  // Last frame written, for diff-based repaint (anti-flicker). Reset to [] whenever
  // the whole screen is invalidated (alt-screen entry, resize) so the next redraw
  // repaints from scratch.
  let prevFrame: string[] = [];

  // Enter the alternate screen, hide the cursor, clear it, and invalidate the diff
  // baseline so the first redraw is a full paint.
  // Mouse capture: ON gives the app wheel-scroll (and click-to-toggle) but, per
  // the terminal mouse protocol, suppresses native click-drag text selection.
  // Ctrl+G toggles it off so the user can select/copy text (then back on). The
  // alt-screen (re-)entry honours the current choice rather than forcing it on.
  let mouseCapture = true;
  const enterAlt = () => { stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H" + (mouseCapture ? MOUSE_ENABLE : MOUSE_DISABLE)); prevFrame = []; };
  const leaveAlt = () => stdout.write("\x1b[?25h\x1b[?1049l");

  // Attach the input listeners in the one order that keeps the mouse working:
  // the raw mouse reader (`onStdinData`) MUST run before readline's internal
  // `"data"` handler so it can intercept SGR mouse sequences and set the
  // `suppressKeys` window before readline fragments them into keystrokes.
  //
  // readline (via `emitKeypressEvents`) attaches its own `"data"` listener the
  // first time a `keypress` listener is added, and — critically — it does NOT
  // remove that listener when the `keypress` listener is removed (it self-removes
  // lazily, only the next time it fires with zero keypress listeners). So after a
  // suspend/re-enter cycle readline's `onData` is still attached, and a plain
  // `stdin.on("data", onStdinData)` would land AFTER it, inverting the order and
  // leaking raw mouse digits. Using `prependListener` guarantees `onStdinData`
  // runs first on every (re-)entry regardless of readline's stale handler.
  function attachInput(): void {
    stdin.prependListener("data", onStdinData);
    stdin.on("keypress", onKey);
    stdin.resume();
  }

  function detachInput(): void {
    try { stdin.removeListener("keypress", onKey); } catch { /* */ }
    try { stdin.removeListener("data", onStdinData); } catch { /* */ }
  }

  function restore(): void {
    if (restored) return;
    restored = true;
    try { if (tty.isTTY) tty.setRawMode?.(false); } catch { /* best effort */ }
    detachInput();
    try { stdout.write(MOUSE_DISABLE); } catch { /* */ }
    try { leaveAlt(); } catch { /* */ }
    try { stdin.pause(); } catch { /* */ }
  }

  const colorEnabled = resolveColorEnabled({
    env: process.env,
    // The TUI is inherently interactive (raw stdin), but npm/tsx can leave
    // stdout.isTTY unset — treat either stream being a TTY as color-capable.
    isTTY: Boolean((stdout as { isTTY?: boolean }).isTTY) || Boolean((stdin as { isTTY?: boolean }).isTTY),
  });
  // ── 10A.18: runtime-switchable named theme (/theme <name>) ──
  let themeName: ThemeName = "default";
  let theme: Theme = createNamedTheme(themeName, colorEnabled);
  // ── 10A.13: contextual help overlay (toggled with `?`) ──
  let helpVisible = false;
  // ── 10A.9: scrollback search (Ctrl+F) ──
  let search: TranscriptSearchState = createSearchState();
  // ── 10A.11: compact live activity timeline (shown in the menu slot while busy) ──
  let activity: ActivityTimelineState = createActivityTimeline();
  const currentHelpMode = (): HelpMode =>
    pendingApproval ? "approval"
    : busy ? "busy"
    : chat.slashMenu.open ? "slash-menu"
    : transcript.selectedBlockId ? "focused-block"
    : "normal";
  // ── 10A.17: persistent bottom footer hints ──
  const currentFooterMode = (): FooterHintMode =>
    pendingApproval ? "approval"
    : busy ? "busy"
    : search.active ? "search"
    : fileCompleter.active ? "file-completer"
    : chat.slashMenu.open ? "slash-menu"
    : transcript.selectedBlockId ? "focused-block"
    : "normal";

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
        const bodyMeta: RenderedTranscriptRow = { text: "", blockId: b.id, kind: b.kind, header: false, collapsible: true };
        if (expanded && b.body) {
          for (const ln of b.body.split("\n")) {
            out.push({ text: "  " + ln, style: theme.dim, meta: bodyMeta });
          }
        } else if (!expanded) {
          // 10A.16: collapsed blocks render as a compact card — summary + a short
          // bounded preview of the output, so failures/results are visible without expanding.
          const preview = buildBlockPreview(b, { maxPreviewLines: 2 });
          if (preview.summary) out.push({ text: "  " + preview.summary, style: theme.dim, meta: bodyMeta });
          for (const ln of preview.previewLines) {
            out.push({ text: "  " + ln, style: b.isError ? theme.error : theme.dim, meta: bodyMeta });
          }
          if (preview.truncated) out.push({ text: `  … ${preview.lineCount} lines · Enter to expand`, style: theme.dim, meta: bodyMeta });
        }
      } else if (b.kind === "assistant" && b.body) {
        // 10A.15: a stable header + progressive Markdown that never corrupts an
        // open code fence — used for BOTH the streaming and the finished message.
        const rendered = renderAssistantBlock({ body: b.body, finished: b.finishedAt !== undefined, width, theme, modelLabel: session.config.model });
        out.push({ text: theme.dim(rendered.header), style: (s) => s, final: true });
        for (const ln of rendered.lines) out.push({ text: ln, style: (s) => s, final: true });
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
    // In search mode the composer becomes the search query line (10A.9).
    if (search.active) {
      const count = search.matches.length;
      const pos = count ? `${search.selected + 1}/${count}` : "no matches";
      return [`search: ${search.query}  (${pos})  ·  Enter next · ↑/↓ prev/next · Esc exit`];
    }
    const buf = editor.text.length ? editor.text.split("\n") : [""];
    // Locate the cursor (line, col) and draw a reverse-video caret there — the
    // alt-screen hides the real terminal cursor, so this is the only insertion marker.
    let rem = editor.cursor;
    let cl = 0;
    for (; cl < buf.length; cl++) {
      if (rem <= buf[cl].length) break;
      rem -= buf[cl].length + 1; // +1 for the newline
    }
    if (cl >= buf.length) { cl = buf.length - 1; rem = buf[cl].length; }
    return buf.map((l, i) => {
      const prefix = i === 0 ? "> " : "  ";
      if (i !== cl) return prefix + l;
      const at = l.slice(rem, rem + 1) || " ";
      return prefix + l.slice(0, rem) + "\x1b[7m" + at + "\x1b[27m" + l.slice(rem + 1);
    });
  }

  /** If the token under cursor starts with `@`, return the `@` start + the query text after it. */
  function atTokenAtCursor(text: string, cursor: number): { start: number; prefix: string } | null {
    if (cursor === 0) return null;
    let start = cursor;
    while (start > 0 && text[start - 1] !== ' ' && text[start - 1] !== '\n') start--;
    const word = text.slice(start, cursor);
    if (word.startsWith('@')) {
      return { start, prefix: word.slice(1) };
    }
    return null;
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
        { id: "footer", fixedHeight: 1 },
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
    // Show more of the catalog when the menu first opens (typing narrows it).
    chat = reduceChatUi(chat, { type: "input-changed", text: editor.text, maxVisible: 12 }, { maxTop: transcriptMaxTop() });
  }

  /**
   * Recompute the file completer from the current editor text.
   * Opens when the token at cursor starts with `@`; closes when the token
   * no longer qualifies or the file index is unavailable.
   */
  function updateFileCompleter(): void {
    const tok = atTokenAtCursor(editor.text, editor.cursor);
    if (tok && fileIndex) {
      const matches = queryFiles(fileIndex, tok.prefix);
      fileCompleter = {
        active: matches.length > 0,
        prefix: tok.prefix,
        matches,
        selected: Math.min(fileCompleter.selected, matches.length - 1),
        cursorPos: editor.cursor,
      };
    } else {
      fileCompleter = { active: false, prefix: "", matches: [], selected: 0, cursorPos: 0 };
    }
  }

  function redraw(): void {
    if (restored) return;
    const width = stdout.columns ?? 80;
    // Wrap logical lines to the terminal width so nothing is truncated off-screen
    // and a resize re-wraps cleanly. renderFrame's own (ANSI-aware) truncate no-ops.
    const composer = composerLines();
    // File completer dropdown (mutually exclusive with slash menu / activity).
    const completerLines = fileCompleter.active && fileCompleter.matches.length > 0
      ? renderCompleterDropdown(fileCompleter.matches, fileCompleter.selected).lines
      : [];
    // The slash dropdown is suppressed while an approval/help overlay owns the screen.
    const overlayActive = pendingApproval !== null || helpVisible;
    // Menu slot: slash dropdown when open; otherwise a compact live activity
    // timeline (10A.11) while a turn is running; nothing when idle.
    const menu = overlayActive ? []
      : fileCompleter.active ? [] // completer dropdown shown separately
      : chat.slashMenu.open ? menuRows(width)
      : busy ? renderActivityTimeline(activity, { width, maxRows: 3, theme })
      : [];
    const totalMenuCount = menu.length + completerLines.length;
    const height = viewportH(composer.length, totalMenuCount);
    // While an approval/help overlay is up, the content window IS the overlay.
    const built = overlayActive ? null : buildLinesWithMeta(width);
    // 10A.19: a fresh session (no conversation yet, only the intro notice) shows
    // a welcome empty-state instead of a near-blank screen.
    const showEmpty = built !== null && !transcript.blocks.some((b) => b.kind !== "notice");
    const lines = showEmpty
      ? renderEmptyState({ width, height, tokens: createStyleTokens(theme) })
      : built
        ? built.lines
        : pendingApproval
          ? renderApprovalReview({ review: buildApprovalReview({ description: pendingApproval.description, diff: pendingApproval.diff }), width, height, scroll: approvalScroll, mode: approvalReviewMode, theme })
          : renderHelpOverlay({ mode: currentHelpMode(), width, height, color: colorEnabled }, theme);
    const maxTop = Math.max(0, lines.length - height);
    // Derive the display offset from chat state without mutating it: an approval
    // pins to top, a bottom-stuck view snaps to maxTop, else clamp the saved top.
    // Search mode (10A.9) centers the viewport on the selected match.
    const sm = search.active ? selectedMatch(search) : null;
    const viewportTop = overlayActive ? 0
      : sm ? Math.min(Math.max(0, sm.line - Math.floor(height / 2)), maxTop)
      : chat.atBottom ? maxTop : Math.min(Math.max(0, chat.viewportTop), maxTop);
    const hasNewOutputBelow = !overlayActive && !search.active && !chat.atBottom && viewportTop < maxTop;
    // Capture geometry for mouse hit-testing (only meaningful for the transcript).
    lastRowMeta = built && !showEmpty ? built.meta : [];
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
      title: session.title,
      raw: session.rawMode,
      side: sideState?.active === true,
    };
    const status = renderStatusBar(info, width, theme, session.config.statusline?.fields);
    const frame = renderFrame({
      statusLine: status, lines, viewportTop, height,
      width, inputLine: composer[0], inputLines: composer,
      hasNewOutputBelow,
      menuLines: menu.length ? menu : undefined,
      completerLines: completerLines.length ? completerLines : undefined,
      footerLine: renderFooterHints({ mode: currentFooterMode(), width, theme }),
      raw: session.rawMode,
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
    emit: (e: UiEvent) => { transcript = applyEvent(transcript, e); activity = applyActivityEvent(activity, e, Date.now()); redraw(); },
    endTurn: () => { redraw(); },
  };
  const approval = createTuiApproval({
    nextKey: () => new Promise<string>((res) => { approvalResolve = res; }),
    onRender: (req) => { pendingApproval = { description: req.description, diff: req.diff }; approvalScroll = 0; approvalReviewMode = "diff"; stickBottom(); redraw(); },
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

  /** Drain one queued item when idle. Guarded against re-entrancy (checks busy). */
  async function drainQueue(): Promise<void> {
    if (busy || queueDepth(queue) === 0) return;
    const { queue: newQueue, line } = dequeue(queue);
    queue = newQueue;
    if (line !== null) {
      await handleSubmit(line);
    }
  }

  async function handleSubmit(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) { redraw(); return; }
    // /exit still works even when busy — check before the enqueue guard.
    if (line === "/exit" || line === "/quit") { pushUser(line); stickBottom(); redraw(); restore(); resolveDone(); return; }

    // ── Side conversation: return to main ──
    if (line === "/main" || line === "/back") {
      if (!sideState) {
        transcript = applyEvent(transcript, { type: "notice", message: "Not in a side conversation." });
        stickBottom(); redraw(); return;
      }
      const restored = returnToMain(sideState);
      session.messages = restored.messages;
      session.readTracker = restored.readTracker;
      session.writeTracker = restored.writeTracker;
      sideState = null;
      transcript = applyEvent(transcript, { type: "notice", message: "Returned to main thread." });
      stickBottom(); redraw(); return;
    }

    // ── Side conversation: fork on /side or /btw ──
    const sideMatch = line.match(/^\/(side|btw)\s*(.*)/);
    if (sideMatch) {
      const question = sideMatch[2]!.trim();
      sideState = forkSide(sideState, session.messages, session.readTracker, session.writeTracker);
      if (question) {
        // Single-turn: push question, swap to side messages, run, restore.
        sideState.sideMessages.push({ role: "user", content: question });
        const savedMessages = session.messages;
        const savedRead = session.readTracker;
        const savedWrite = session.writeTracker;
        session.messages = sideState.sideMessages;
        session.readTracker = sideState.mainReadTracker;
        session.writeTracker = sideState.mainWriteTracker;
        busy = true; redraw();
        try { await runTask(session, { sink, approve }); }
        catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `[side] Error: ${(e as Error).message ?? e}` }); }
        finally { busy = false; stickBottom(); redraw(); }
        sideState.sideMessages = session.messages;
        session.messages = savedMessages;
        session.readTracker = savedRead;
        session.writeTracker = savedWrite;
        const restored = returnToMain(sideState);
        session.messages = restored.messages;
        session.readTracker = restored.readTracker;
        session.writeTracker = restored.writeTracker;
        sideState = null;
      }
      // else: multi-turn mode — stays in side until /main or /back
      return;
    }

    // ── Side conversation: active — route user input to side messages ──
    if (sideState) {
      pushUser(line); stickBottom(); redraw();
      sideState.sideMessages.push({ role: "user", content: line });
      const savedMessages = session.messages;
      const savedRead = session.readTracker;
      const savedWrite = session.writeTracker;
      session.messages = sideState.sideMessages;
      session.readTracker = sideState.mainReadTracker;
      session.writeTracker = sideState.mainWriteTracker;
      busy = true; redraw();
      try { await runTask(session, { sink, approve }); }
      catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `[side] Error: ${(e as Error).message ?? e}` }); }
      finally {
        sideState.sideMessages = session.messages;
        session.messages = savedMessages;
        session.readTracker = savedRead;
        session.writeTracker = savedWrite;
        busy = false; stickBottom(); redraw();
      }
      await drainQueue();
      return;
    }

    // Enqueue if the agent is busy (type-ahead).
    if (decideSubmit(busy) === "enqueue") {
      queue = enqueue(queue, line);
      transcript = applyEvent(transcript, { type: "notice", message: `queued: ${line}` });
      stickBottom(); redraw(); return;
    }
    pushUser(line); stickBottom(); redraw();
    // Phase 10R: `!cmd` shell-escape (the user block was already echoed by pushUser).
    {
      const bang = parseBangCommand(line);
      if (bang !== null) {
        if (bang === "") {
          transcript = applyEvent(transcript, { type: "notice", message: "Usage: !<command> — run a shell command, e.g. !ls -la" });
          stickBottom(); redraw(); return;
        }
        const decision = decideBang(bang, session.mode, classifyCommand);
        if (decision.action === "refuse") {
          transcript = applyEvent(transcript, { type: "notice", message: `Refused: ${decision.reason}.` });
          stickBottom(); redraw(); return;
        }
        if (decision.action === "confirm") {
          // Raw-mode-safe confirm: reuse the approval review panel (no readline).
          const ok = await approve(runBashTool.build({ command: bang }));
          if (!ok) { transcript = applyEvent(transcript, { type: "notice", message: "Cancelled." }); stickBottom(); redraw(); return; }
        }
        busy = true; redraw();
        const controller = new AbortController();
        const onSig = () => controller.abort();
        process.once("SIGINT", onSig);
        try {
          const { output, isError } = await executeBang(session, bang, controller.signal);
          transcript = applyEvent(transcript, { type: "notice", message: (isError ? "✗ " : "") + (output || "(no output)") });
        } catch (e) {
          transcript = applyEvent(transcript, { type: "notice", message: `Error: ${(e as Error).message ?? e}` });
        } finally {
          process.removeListener("SIGINT", onSig); busy = false; await drainQueue(); stickBottom(); redraw();
        }
        return;
      }
    }
    if (line.startsWith("/")) {
      const cmd = (line.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
      // 10A.18: /theme switches the live palette and repaints (no suspend).
      if (cmd === "theme") {
        const name = line.slice(1).split(/\s+/)[1];
        if (!name) {
          transcript = applyEvent(transcript, { type: "notice", message: `theme: ${themeName} · available: ${listThemeNames().join(", ")} · use /theme <name>` });
        } else if (isValidThemeName(name)) {
          themeName = name; theme = createNamedTheme(themeName, colorEnabled); prevFrame = [];
          transcript = applyEvent(transcript, { type: "notice", message: `theme set to ${themeName}` });
        } else {
          transcript = applyEvent(transcript, { type: "notice", message: `unknown theme "${name}" · available: ${listThemeNames().join(", ")}` });
        }
        stickBottom(); redraw(); return;
      }
      if (!slashNeedsSuspend(cmd)) {
        // Capture the command's stdout and show it as a transcript block — no
        // alt-screen suspend, so the output stays in the scrollable UI. This is
        // the DEFAULT: only long-running/streaming/interactive commands suspend.
        const buf: string[] = [];
        const cap = (...a: unknown[]) => { buf.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); };
        const origLog = console.log;
        const origErr = console.error;
        const origWrite = stdout.write.bind(stdout);
        console.log = cap as typeof console.log;
        console.error = cap as typeof console.error;
        (stdout as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
          buf.push(typeof s === "string" ? s.replace(/\n+$/, "") : String(s));
          return true;
        };
        try {
          await handleSlashCommand(line, session, () => session.store.save(snapshot(session)), () => runTask(session));
        } catch (e) {
          buf.push(`Error: ${(e as Error).message ?? e}`);
        } finally {
          console.log = origLog;
          console.error = origErr;
          (stdout as unknown as { write: typeof origWrite }).write = origWrite;
        }
        const text = buf.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
        transcript = applyEvent(transcript, { type: "notice", message: text || `(/${cmd}: no output)` });
        stickBottom();
        redraw();
        return;
      }
      restore(); restored = false; // suspend: run the command on the normal screen
      try {
        await handleSlashCommand(line, session, () => session.store.save(snapshot(session)), () => runTask(session));
      } catch (e) { stdout.write(chalk.red(`\nError: ${(e as Error).message ?? e}\n`)); }
      enterAlt();
      if (tty.isTTY) tty.setRawMode?.(true);
      attachInput();
      redraw();
      return;
    }
    const root = session.executionRoot ?? session.config.workspaceRoot;
    const exp = expandMentions(line, { resolve: (p) => resolveReadPathInWorkspace(root, p), readFile: (p) => readFileSync(p, "utf8") });
    for (const s of exp.skipped) {
      transcript = applyEvent(transcript, { type: "notice", message: `@${s.path}: ${s.reason}` });
    }
    session.messages.push({ role: "user", content: exp.prompt });
    busy = true; redraw();
    try { await runTask(session, { sink, approve }); }
    catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `Error: ${(e as Error).message ?? e}` }); }
    finally { busy = false; stickBottom(); redraw(); }

    // Interactive Plan Mode: after an investigating turn, the assistant's final
    // text is the proposed plan. Prompt the user to approve or reject it — this
    // runs BEFORE draining the input queue, since the plan belongs to this turn.
    if ((session.planState ?? initPlanMode()).phase === "investigating") {
      const lastAssistant = [...session.messages].reverse().find(
        (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0,
      );
      if (lastAssistant && typeof lastAssistant.content === "string") {
        const planState = session.planState ?? initPlanMode();
        session.planState = recordPlan(planState, lastAssistant.content);
        const ok = await approval.approve({ description: "Execute this plan?\n\n" + lastAssistant.content });
        if (ok) {
          session.planState = approvePlan(session.planState);
          session.messages.push({ role: "user", content: `Execute this plan:\n${lastAssistant.content}` });
          busy = true; redraw();
          try { await runTask(session, { sink, approve }); }
          catch (e) { transcript = applyEvent(transcript, { type: "notice", message: `Error: ${(e as Error).message ?? e}` }); }
          finally { busy = false; stickBottom(); redraw(); }
          session.planState = exitPlanMode(session.planState);
        } else {
          session.planState = rejectPlan(session.planState);
          transcript = applyEvent(transcript, { type: "notice", message: "Plan rejected. Staying in read-only investigation mode." });
          stickBottom(); redraw();
        }
      }
    }

    // Type-ahead: run the next queued input (chains via this same path until drained).
    await drainQueue();
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
      // `d` toggles the review panel between diff and details (10A.20) without resolving.
      if (str === "d") { approvalReviewMode = approvalReviewMode === "diff" ? "details" : "diff"; approvalScroll = 0; redraw(); return; }
      const r = approvalResolve; approvalResolve = null;
      r(key?.name === "escape" ? "escape" : (str ?? key?.sequence ?? key?.name ?? ""));
      return;
    }
    // 10A.13 help overlay: while it's up, any key dismisses it; otherwise `?`
    // on an empty composer opens it (so `?` still types into a real prompt).
    if (helpVisible) { helpVisible = false; redraw(); return; }
    if (str === "?" && !busy && editor.text.length === 0 && !chat.slashMenu.open) {
      helpVisible = true; redraw(); return;
    }
    // 10A.9 scrollback search: Ctrl+F toggles; while active, the composer is the
    // query line and these keys drive it (everything else is swallowed).
    if (key?.ctrl && key?.name === "f" && !busy && !pendingApproval) {
      search = { ...createSearchState(), active: !search.active };
      redraw(); return;
    }
    // Ctrl+G releases/re-grabs the mouse so the user can select text natively
    // (capturing the wheel suppresses the terminal's own click-drag selection).
    if (key?.ctrl && key?.name === "g" && !pendingApproval) {
      mouseCapture = !mouseCapture;
      try { stdout.write(mouseCapture ? MOUSE_ENABLE : MOUSE_DISABLE); } catch { /* */ }
      transcript = applyEvent(transcript, { type: "notice", message: mouseStatusNotice(mouseCapture) });
      stickBottom(); redraw(); return;
    }
    if (search.active) {
      const w = stdout.columns ?? 80;
      if (key?.name === "escape") { search = createSearchState(); redraw(); return; }
      if (key?.name === "return") { search = moveSearchSelection(search, 1); redraw(); return; }
      if (key?.name === "up") { search = moveSearchSelection(search, -1); redraw(); return; }
      if (key?.name === "down") { search = moveSearchSelection(search, 1); redraw(); return; }
      if (key?.name === "backspace") { search = updateSearch(search, buildLines(w), search.query.slice(0, -1)); redraw(); return; }
      if (str && str.length === 1 && str >= " " && !key?.ctrl) { search = updateSearch(search, buildLines(w), search.query + str); redraw(); return; }
      return; // swallow anything else while searching
    }
    // 10A.12 copy/export the focused block: `y` copies to clipboard, `s` saves
    // to .deepcoder/exports/. Only on an empty composer so normal typing is free.
    if (!busy && editor.text.length === 0 && !chat.slashMenu.open && (str === "y" || str === "s")) {
      const blk = selectedBlock(transcript);
      if (!blk) {
        transcript = applyEvent(transcript, { type: "notice", message: "No focused block. Press Tab to focus a tool/check/worker block." });
        stickBottom(); redraw(); return;
      }
      const md = formatTranscriptBlockMarkdown(blk);
      if (str === "y") {
        void copyToClipboard(md).then((r) => {
          transcript = applyEvent(transcript, { type: "notice", message: r.ok ? `Copied focused block to clipboard (${r.backend}).` : `Copy failed: ${r.error}` });
          stickBottom(); redraw();
        });
      } else {
        try {
          const dir = path.join(session.executionRoot ?? session.config.workspaceRoot, ".deepcoder", "exports");
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, safeExportFilename(blk.kind, new Date(), blk.id));
          writeFileSync(file, md, "utf8");
          transcript = applyEvent(transcript, { type: "notice", message: `Saved focused block to ${file}` });
        } catch (e) {
          transcript = applyEvent(transcript, { type: "notice", message: `Save failed: ${(e as Error).message}` });
        }
        stickBottom(); redraw();
      }
      return;
    }
    // Composer cursor movement (←/→ and Ctrl+A/Ctrl+E for line start/end), so the
    // input is editable mid-string rather than append/backspace-only.
    if (!busy && key?.name === "left") { editor = reduceEditor(editor, { type: "left" }).state; redraw(); return; }
    if (!busy && key?.name === "right") { editor = reduceEditor(editor, { type: "right" }).state; redraw(); return; }
    if (!busy && key?.ctrl && key?.name === "a") { editor = reduceEditor(editor, { type: "home" }).state; redraw(); return; }
    if (!busy && key?.ctrl && key?.name === "e") { editor = reduceEditor(editor, { type: "end" }).state; redraw(); return; }
    // Alt/Meta + Enter inserts a newline instead of submitting (multiline compose).
    if (key?.name === "return" && (key as { meta?: boolean }).meta) {
      if (!busy) { editor = reduceEditor(editor, { type: "newline" }).state; syncMenu(); redraw(); }
      return;
    }
    // Tab: navigate file completer, complete slash command, or step focus.
    if (key?.name === "tab") {
      if (busy) return;
      // File completer: Tab selects next match, Shift+Tab selects previous.
      if (fileCompleter.active && fileCompleter.matches.length > 0) {
        const shift = (key as { shift?: boolean }).shift ?? false;
        const delta = shift ? -1 : 1;
        const next = (fileCompleter.selected + delta + fileCompleter.matches.length) % fileCompleter.matches.length;
        fileCompleter = { ...fileCompleter, selected: next };
        redraw();
        return;
      }
      if (chat.slashMenu.open) {
        const completed = completeSelected(chat.slashMenu);
        if (completed !== null) { editor = { ...editor, text: completed, cursor: completed.length }; syncMenu(); updateFileCompleter(); redraw(); }
        return;
      }
      transcript = moveSelection(transcript, (key as { shift?: boolean }).shift ? -1 : 1);
      stickBottom();
      redraw();
      return;
    }
    // Configurable keybinds: route scroll/page navigation through the resolved
    // keybind table so a user's `.deepcoder/config.json` `keybinds` override wins
    // (defaults unchanged). Approval/search/menu modes already returned above.
    {
      const ka = actionForKey(session.config.keybinds, {
        ctrl: key?.ctrl,
        alt: (key as { meta?: boolean } | undefined)?.meta,
        shift: (key as { shift?: boolean } | undefined)?.shift,
        key: key?.name ?? str ?? "",
      });
      if (ka === "scroll-up" || ka === "scroll-down" || ka === "page-up" || ka === "page-down") {
        const pageAmt = Math.max(1, Math.floor((stdout.rows ?? 24) / 2));
        if (ka === "scroll-up") dispatch({ type: "scroll-up" });
        else if (ka === "scroll-down") dispatch({ type: "scroll-down" });
        else dispatch({ type: ka === "page-up" ? "scroll-up" : "scroll-down", amount: pageAmt });
        return;
      }
    }
    const named = key?.name ? keyToAction(key.name) : "none";
    const action = named !== "none" ? named : keyToAction(key?.sequence ?? str ?? "");
    const inputCount = composerLines().length;
    const half = Math.max(1, Math.floor(viewportH(inputCount, menuRows(stdout.columns ?? 80).length) / 2));
    switch (action) {
      case "interrupt":
        if (busy) { queue = createInputQueue(); try { process.kill(process.pid, "SIGINT"); } catch { /* */ } }
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
        // Esc closes the file completer first, then the slash menu, then clears selection.
        if (fileCompleter.active) {
          fileCompleter = { active: false, prefix: "", matches: [], selected: 0, cursorPos: 0 };
          redraw(); return;
        }
        if (chat.slashMenu.open) { chat = reduceChatUi(chat, { type: "menu-close" }, { maxTop: 0 }); redraw(); return; }
        transcript = clearSelection(transcript); stickBottom(); redraw(); return;
      case "submit": {
        if (busy) return;
        // File completer: Enter accepts the selected match and inserts the path.
        if (fileCompleter.active && fileCompleter.matches.length > 0) {
          const selected = fileCompleter.matches[fileCompleter.selected];
          if (selected) {
            const tok = atTokenAtCursor(editor.text, editor.cursor);
            if (tok) {
              const before = editor.text.slice(0, tok.start);
              const after = editor.text.slice(editor.cursor);
              editor = { ...editor, text: before + '@' + selected + after, cursor: tok.start + 1 + selected.length };
            }
          }
          fileCompleter = { active: false, prefix: "", matches: [], selected: 0, cursorPos: 0 };
          redraw(); return;
        }
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
        updateFileCompleter();
        redraw();
    }
  }

  // ── setup (raw mode + alternate screen), with guaranteed restore ──
  enterAlt();
  // Install readline's keypress machinery once. `attachInput` then prepends the
  // raw mouse reader (`onStdinData`) ahead of readline's internal `"data"`
  // handler so it sees each chunk first and can suppress the keypress fragments a
  // mouse sequence would spawn. The same helper is reused on slash-suspend
  // re-entry so the listener order can never drift between the two paths.
  emitKeypressEvents(stdin);
  if (tty.isTTY) tty.setRawMode?.(true);
  attachInput();
  const onProcExit = () => restore();
  process.on("exit", onProcExit);
  process.on("SIGTERM", onProcExit);
  stdout.on("resize", onResize);
  transcript = applyEvent(transcript, { type: "notice", message: "deepcoder TUI (experimental) — type / for commands · !cmd for shell · mouse-wheel/PgUp/PgDn scroll · Ctrl+G release mouse to select text · Tab inspect tool output · ↑/↓ history · Alt+Enter newline · Enter submit · Esc collapse · Ctrl+C exit · /exit quits" });
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
  // Build the file index once at startup for @-file autocomplete (best-effort).
  void (async () => {
    try {
      fileIndex = await buildFileIndex(session.executionRoot ?? session.config.workspaceRoot);
    } catch { /* best-effort — @-completer gracefully shows nothing */ }
  })();
  redraw();
  try {
    await done;
  } finally {
    session.fileWatcher?.stop();
    restore();
    stdout.removeListener("resize", onResize);
    process.removeListener("exit", onProcExit);
    process.removeListener("SIGTERM", onProcExit);
  }
}
