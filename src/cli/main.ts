#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type ApprovalMode } from "../config/config.js";
import { createProvider } from "../providers/factory.js";
import { defaultRegistry } from "../tools/registry.js";
import { runOneShot, runRepl, systemMessage, type Session } from "./repl.js";
import {
  SessionStore,
  newSessionId,
  loadSession,
  listSessions,
  latestSessionId,
} from "../session/sessionStore.js";
import { McpManager } from "../mcp/registry.js";
import { CheckpointRecorder } from "../session/checkpoints.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Config } from "../config/config.js";

const program = new Command();

program
  .name("deepcoder")
  .description("A small, model-agnostic agentic coding CLI (DeepSeek).")
  .argument("[prompt...]", "task to run once and exit; omit for interactive mode")
  .option("--mode <mode>", "approval mode: ask | auto | readonly")
  .option("--resume [id]", "resume a saved session (most recent if id omitted)")
  .option("--list-sessions", "list saved sessions and exit")
  .option("--planning-model <model>", "model used by /plan (default: deepseek-reasoner)")
  .option("--plan-first", "for a one-shot run: plan with the reasoner model first, then edit")
  .action(
    async (
      promptParts: string[],
      opts: {
        mode?: string;
        resume?: string | boolean;
        listSessions?: boolean;
        planningModel?: string;
        planFirst?: boolean;
      },
    ) => {
    const baseConfig = loadConfig({
      ...(opts.mode ? { approvalMode: opts.mode as ApprovalMode } : {}),
      ...(opts.planningModel ? { reasonerModel: opts.planningModel } : {}),
      ...(opts.planFirst ? { planFirst: true } : {}),
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
  const provider = createProvider(config);
  const registry = defaultRegistry();
  const mcp = await initMcp(config, registry);
  const recorder = config.checkpoints === "off" ? undefined : new CheckpointRecorder(config.workspaceRoot);

  if (resume) {
    const id =
      typeof resume === "string" ? resume : await latestSessionId(config.workspaceRoot);
    if (!id) throw new Error("No saved session to resume.");
    const saved = await loadSession(config.workspaceRoot, id);
    // Recover any not-yet-finalized checkpoint window (manual mode / interrupted run).
    if (recorder && saved.pendingCheckpoint?.length) recorder.load(saved.pendingCheckpoint);
    // Only restore the saved model if it belongs to the SAME backend (provider
    // AND base URL) — otherwise we'd point a saved model at an incompatible
    // endpoint. On a change, keep the current model and warn.
    const sameBackend =
      (!saved.provider || saved.provider === config.provider) &&
      (saved.baseUrl ?? "") === (config.baseUrl ?? "");
    const cfg = sameBackend ? { ...config, model: saved.model } : config;
    if (!sameBackend) {
      console.log(
        chalk.yellow(
          `Session backend changed (provider/base URL); keeping current model "${config.model}" (saved "${saved.model}" not restored).`,
        ),
      );
    }
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
      writeTracker: new Set(saved.writeTracker ?? []),
      reviews: saved.reviews ?? [],
      mcp,
      recorder,
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
    writeTracker: new Set<string>(),
    reviews: [],
    mcp,
    recorder,
  };
}

/** Connect configured MCP servers and register their tools. Returns undefined
 *  when none are configured; never throws (bad servers warn and are skipped). */
async function initMcp(config: Config, registry: ToolRegistry): Promise<McpManager | undefined> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return undefined;
  const manager = new McpManager(config.mcpServers);
  await manager.connectAll();
  await manager.registerInto(registry);
  const bad = manager.status().filter((s) => s.error && s.error !== "disabled");
  for (const s of bad) console.error(chalk.yellow(`MCP server "${s.name}" unavailable: ${s.error}`));
  return manager;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exit(1);
});
