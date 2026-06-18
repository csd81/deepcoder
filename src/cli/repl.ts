import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { Config } from "../config/config.js";
import type { ModelProvider, AgentMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult } from "../tools/types.js";
import { runAgentLoop, type AgentDeps } from "../agent/agentLoop.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { promptForApproval } from "../permissions/prompt.js";
import { handleSlashCommand, type ReplState } from "./slashCommands.js";

export interface Session {
  config: Config;
  provider: ModelProvider;
  registry: ToolRegistry;
  /** Absolute paths read this session — shared so edits require a prior read. */
  readTracker: Set<string>;
}

function makeContext(config: Config, signal: AbortSignal, readTracker: Set<string>): ToolContext {
  return { workspaceRoot: config.workspaceRoot, signal, readTracker };
}

function hooks(): Pick<AgentDeps, "onAssistantText" | "onToolCall" | "onToolResult" | "onNotice" | "approve"> {
  return {
    onAssistantText: (text) => {
      if (text.trim()) stdout.write("\n" + text.trim() + "\n");
    },
    onToolCall: (name, describe) => {
      stdout.write(chalk.dim(`\n● ${name}: ${describe}\n`));
    },
    onToolResult: (_name, result: ToolResult) => {
      const text = result.output.length > 800 ? result.output.slice(0, 800) + "\n…(truncated)" : result.output;
      stdout.write((result.isError ? chalk.red(text) : chalk.dim(text)) + "\n");
    },
    onNotice: (m) => stdout.write(chalk.yellow(`\n${m}\n`)),
    approve: (invocation: ToolInvocation, preview?: ToolPreview) => promptForApproval(invocation, preview),
  };
}

async function runTask(session: Session, state: ReplState): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  // readTracker persists for the lifetime of the session, not just one task.
  const ctx = makeContext(session.config, controller.signal, session.readTracker);

  try {
    await runAgentLoop(state.messages, {
      provider: session.provider,
      registry: session.registry,
      ctx,
      model: session.config.model,
      mode: state.mode,
      maxTurns: session.config.maxTurns,
      ...hooks(),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function initialMessages(config: Config, mode: ReplState["mode"]): AgentMessage[] {
  return [{ role: "system", content: buildSystemPrompt({ workspaceRoot: config.workspaceRoot, mode }) }];
}

/** Non-interactive: run a single task and exit. */
export async function runOneShot(session: Session, prompt: string): Promise<void> {
  const state: ReplState = { mode: session.config.approvalMode, messages: initialMessages(session.config, session.config.approvalMode) };
  state.messages.push({ role: "user", content: prompt });
  await runTask(session, state);
}

/** Interactive REPL. */
export async function runRepl(session: Session): Promise<void> {
  const state: ReplState = { mode: session.config.approvalMode, messages: initialMessages(session.config, session.config.approvalMode) };
  stdout.write(
    chalk.bold("deepcoder") +
      chalk.dim(` — ${session.config.model} | mode: ${state.mode} | ${session.config.workspaceRoot}\n`) +
      chalk.dim("Type a task, or /help for commands.\n"),
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const input = (await rl.question(chalk.cyan("\n› "))).trim();
      if (!input) continue;

      const slash = await handleSlashCommand(input, session.config, state);
      if (slash.exit) break;
      if (slash.consumed) {
        // Keep the system prompt in sync if the mode changed.
        state.messages[0] = { role: "system", content: buildSystemPrompt({ workspaceRoot: session.config.workspaceRoot, mode: state.mode }) };
        continue;
      }

      state.messages.push({ role: "user", content: input });
      try {
        await runTask(session, state);
      } catch (err) {
        stdout.write(chalk.red(`\nError: ${(err as Error).message ?? err}\n`));
      }
    }
  } finally {
    rl.close();
  }
}
