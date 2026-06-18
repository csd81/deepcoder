import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { ApprovalMode, Config } from "../config/config.js";
import type { ModelProvider, AgentMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult, Todo } from "../tools/types.js";
import { runAgentLoop, type AgentDeps } from "../agent/agentLoop.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { promptForApproval } from "../permissions/prompt.js";
import { handleSlashCommand } from "./slashCommands.js";
import { SessionStore, type SessionSnapshot } from "../session/sessionStore.js";
import type { McpManager } from "../mcp/registry.js";
import { CheckpointRecorder } from "../session/checkpoints.js";

/** Mutable runtime state for one interactive (or one-shot) session. */
export interface Session {
  config: Config;
  provider: ModelProvider;
  registry: ToolRegistry;
  store: SessionStore;
  messages: AgentMessage[];
  mode: ApprovalMode;
  todos: Todo[];
  readTracker: Set<string>;
  /** Absolute real paths the agent has mutated this session. */
  writeTracker: Set<string>;
  /** Connected MCP servers (Phase 4A); undefined if none configured. */
  mcp?: McpManager;
  /** Pre-image recorder for checkpoints; undefined when checkpoints are off. */
  recorder?: CheckpointRecorder;
}

export function systemMessage(config: Config, mode: ApprovalMode): AgentMessage {
  const { text } = loadInstructions(config.workspaceRoot);
  return {
    role: "system",
    content: buildSystemPrompt({ workspaceRoot: config.workspaceRoot, mode, instructions: text }),
  };
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
  };
}

async function runTask(session: Session): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const ctx: ToolContext = {
    workspaceRoot: session.config.workspaceRoot,
    signal: controller.signal,
    readTracker: session.readTracker,
    writeTracker: session.writeTracker,
    capturePreImage: session.recorder ? (p) => session.recorder!.capture(p) : undefined,
    recordPostWrite: session.recorder ? (p) => session.recorder!.recordPostWrite(p) : undefined,
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
    if (session.config.checkpoints === "auto" && session.recorder && session.recorder.size > 0) {
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
  session.messages.push({ role: "user", content: prompt });
  await session.store.save(snapshot(session));
  try {
    await runTask(session);
  } finally {
    await session.mcp?.closeAll();
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

      const slash = await handleSlashCommand(input, session, () => session.store.save(snapshot(session)));
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
