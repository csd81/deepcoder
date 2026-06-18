#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type ApprovalMode } from "../config/config.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { defaultRegistry } from "../tools/registry.js";
import { runOneShot, runRepl, systemMessage, type Session } from "./repl.js";
import {
  SessionStore,
  newSessionId,
  loadSession,
  listSessions,
  latestSessionId,
} from "../session/sessionStore.js";

const program = new Command();

program
  .name("deepcoder")
  .description("A small, model-agnostic agentic coding CLI (DeepSeek).")
  .argument("[prompt...]", "task to run once and exit; omit for interactive mode")
  .option("--mode <mode>", "approval mode: ask | auto | readonly")
  .option("--resume [id]", "resume a saved session (most recent if id omitted)")
  .option("--list-sessions", "list saved sessions and exit")
  .option("--planning-model <model>", "model used by /plan (default: deepseek-reasoner)")
  .action(
    async (
      promptParts: string[],
      opts: { mode?: string; resume?: string | boolean; listSessions?: boolean; planningModel?: string },
    ) => {
    const baseConfig = loadConfig({
      ...(opts.mode ? { approvalMode: opts.mode as ApprovalMode } : {}),
      ...(opts.planningModel ? { reasonerModel: opts.planningModel } : {}),
    });

    if (opts.listSessions) {
      const all = await listSessions(baseConfig.workspaceRoot);
      if (all.length === 0) console.log(chalk.dim("No saved sessions."));
      else for (const s of all) console.log(`${s.id}  ${chalk.dim(`${s.messageCount} msgs · ${s.updatedAt}`)}`);
      return;
    }

    const session = await buildSession(baseConfig, opts.resume);

    const prompt = promptParts.join(" ").trim();
    if (prompt) await runOneShot(session, prompt);
    else await runRepl(session);
  });

async function buildSession(
  config: ReturnType<typeof loadConfig>,
  resume?: string | boolean,
): Promise<Session> {
  const provider = new DeepSeekProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const registry = defaultRegistry();

  if (resume) {
    const id =
      typeof resume === "string" ? resume : await latestSessionId(config.workspaceRoot);
    if (!id) throw new Error("No saved session to resume.");
    const saved = await loadSession(config.workspaceRoot, id);
    const cfg = { ...config, model: saved.model };
    console.log(chalk.dim(`Resuming session ${id} (${saved.messages.length} messages).`));
    // Rebuild the system prompt from CURRENT project instructions rather than
    // trusting the (possibly stale) saved one, then keep the rest of history.
    const messages = saved.messages.slice();
    const fresh = systemMessage(cfg, saved.mode);
    if (messages[0]?.role === "system") messages[0] = fresh;
    else messages.unshift(fresh);
    return {
      config: cfg,
      provider,
      registry,
      store: new SessionStore(config.workspaceRoot, id, saved.createdAt),
      messages,
      mode: saved.mode,
      todos: saved.todos,
      readTracker: new Set(saved.readTracker),
    };
  }

  return {
    config,
    provider,
    registry,
    store: new SessionStore(config.workspaceRoot, newSessionId()),
    messages: [systemMessage(config, config.approvalMode)],
    mode: config.approvalMode,
    todos: [],
    readTracker: new Set<string>(),
  };
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exit(1);
});
