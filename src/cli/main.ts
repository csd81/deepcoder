#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type ApprovalMode } from "../config/config.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { defaultRegistry } from "../tools/registry.js";
import { runOneShot, runRepl, type Session } from "./repl.js";

const program = new Command();

program
  .name("deepcoder")
  .description("A small, model-agnostic agentic coding CLI (DeepSeek).")
  .argument("[prompt...]", "task to run once and exit; omit for interactive mode")
  .option("--mode <mode>", "approval mode: ask | auto | readonly")
  .action(async (promptParts: string[], opts: { mode?: string }) => {
    const overrides = opts.mode ? { approvalMode: opts.mode as ApprovalMode } : {};
    const config = loadConfig(overrides);

    const session: Session = {
      config,
      provider: new DeepSeekProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
      registry: defaultRegistry(),
      readTracker: new Set<string>(),
    };

    const prompt = promptParts.join(" ").trim();
    if (prompt) await runOneShot(session, prompt);
    else await runRepl(session);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exit(1);
});
