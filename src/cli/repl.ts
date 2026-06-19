import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { ApprovalMode, Config } from "../config/config.js";
import type { ModelProvider, AgentMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult, Todo } from "../tools/types.js";
import { runAgentLoop, type AgentDeps } from "../agent/agentLoop.js";
import { runPreToolUseHooks } from "../hooks/runner.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { promptForApproval } from "../permissions/prompt.js";
import { handleSlashCommand } from "./slashCommands.js";
import { runSolveCommand } from "./solveRunner.js";
import { SessionStore, type SessionSnapshot } from "../session/sessionStore.js";
import type { McpManager } from "../mcp/registry.js";
import { CheckpointRecorder } from "../session/checkpoints.js";
import type { SubagentRunRecord } from "../subagents/types.js";

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

export function systemMessage(config: Config, mode: ApprovalMode): AgentMessage {
  const { text } = loadInstructions(config.workspaceRoot);
  // Project memory (8B): the control plane is the real workspace root, so memory
  // persists/loads there even under workspace isolation.
  const memory = loadStartupMemorySync(config.workspaceRoot);
  return {
    role: "system",
    content: buildSystemPrompt({ workspaceRoot: config.workspaceRoot, mode, instructions: text, solve: config.solve, memory }),
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
  };
}

async function runTask(session: Session): Promise<void> {
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
  };

  let streaming = false;
  const deps: AgentDeps = {
    provider: session.provider,
    registry: session.registry,
    ctx,
    model: session.config.model,
    mode: session.mode,
    maxTurns: session.config.maxTurns,
    contextBudgetTokens: session.config.contextBudgetTokens,
    compactAt: session.config.compactAt,
    mcpExecuteEnabled: session.config.mcpExecuteEnabled,
    approve: (inv: ToolInvocation, preview?: ToolPreview) => promptForApproval(inv, preview),
    onPreToolUse: preToolUseHook(session),
    onPersist: () => session.store.save(snapshot(session)),
    onAssistantTextDelta: (chunk) => {
      if (!streaming) {
        stdout.write("\n" + chalk.bold("assistant> "));
        streaming = true;
      }
      stdout.write(chunk);
    },
    onAssistantText: (text) => {
      if (text.trim()) stdout.write("\n" + chalk.bold("assistant> ") + text.trim() + "\n");
    },
    onToolCall: (name, describe) => {
      if (streaming) {
        stdout.write("\n");
        streaming = false;
      }
      stdout.write(chalk.dim(`tool ${name}: ${describe}\n`));
    },
    onToolResult: (_name, result: ToolResult) => {
      const text = result.output.length > 800 ? result.output.slice(0, 800) + "\n…(truncated)" : result.output;
      stdout.write((result.isError ? chalk.red(text) : chalk.dim(text)) + "\n");
    },
    onNotice: (m) => stdout.write(chalk.yellow(`\n${m}\n`)),
  };

  let completed = false;
  try {
    await runAgentLoop(session.messages, deps);
    if (streaming) stdout.write("\n");
    completed = true;
  } finally {
    process.removeListener("SIGINT", onSigint);
    // auto mode: finalize a checkpoint even if the run errored or was aborted,
    // so files the agent already wrote always have a rollback point.
    if (!session.isolation && session.config.checkpoints === "auto" && session.recorder && session.recorder.size > 0) {
      try {
        const id = await session.recorder.finalize(completed ? "auto" : "auto:interrupted");
        if (id) stdout.write(chalk.dim(`Checkpoint ${id} saved (${completed ? "auto" : "auto:interrupted"}). /rollback ${id} to undo.\n`));
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
      if (!checkName) {
        stdout.write(chalk.red("--solve requires --check <name> (or DEEPCODER_SOLVE_CHECK).\n"));
        return;
      }
      if (session.config.planFirst) await planFirstPass(session, prompt);
      await runSolveCommand(
        session,
        { task: prompt, checkName, maxAttempts: session.config.solveMaxAttempts },
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

      session.messages.push({ role: "user", content: input });
      await session.store.save(snapshot(session));
      try {
        await runTask(session);
      } catch (err) {
        stdout.write(chalk.red(`\nError: ${(err as Error).message ?? err}\n`));
      }
    }
  } finally {
    rl.close();
    await session.mcp?.closeAll();
  }
}
