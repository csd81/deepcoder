#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type ApprovalMode } from "../config/config.js";
import type { SandboxMode } from "../sandbox/types.js";
import { bwrapAvailable } from "../sandbox/index.js";
import type { WorkspaceIsolationMode } from "../workspaceIsolation/types.js";
import { runOneShot, runRepl, runTuiRepl } from "./repl.js";
import { resolveUiMode } from "../ui/uiMode.js";
import { listSessions } from "../session/sessionStore.js";
import { buildSession, setupIsolation, finalizeIsolation } from "../runtime/sessionFactory.js";

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
  .option("--solve", "closed-loop solve: edit, run --check, retry on failure (needs --check)")
  .option("--check <name>", "configured check to verify with in --solve mode")
  .option("--solve-attempts <n>", "max attempts in --solve mode (default 3)")
  .option("--repro [mode]", "solve: generate a failing repro test as the oracle when no --check exists (auto|off, default off)")
  .option("--repro-path <path>", "workspace-relative path for the generated repro test")
  .option("--telemetry <path>", "write a solve telemetry JSON to this path (headless eval)")
  .option("--preflight", "run context preflight (plan + explorer) before solve attempt 1")
  .option("--sandbox <mode>", "sandbox risky commands: off | fast | bubblewrap | local")
  .option("--contain", "hard workspace containment: no file/shell access escapes the workspace (DEFAULT ON; requires bubblewrap)")
  .option("--no-contain", "[disabled for now] would disable containment; gated behind DEEPCODER_ALLOW_UNCONTAINED=1")
  .option("--yolo", "approve ALL actions within the workspace — no prompts; forces containment ON and disables the MCP-execute + interactive-shell escape hatches")
  .option("--workspace-isolation <mode>", "isolate file edits in a git worktree: off | patch | keep")
  .option("--workspace-isolation-include-dirty", "allow isolation even when the repo has uncommitted changes")
  .option("--tui", "interactive: use the experimental scrollable terminal UI (TTY only)")
  .option("--no-tui", "interactive: force the plain line UI")
  .option("-p, --print", "one-shot: print only the raw assistant reply (no chrome) and exit")
  .action(
    async (
      promptParts: string[],
      opts: {
        mode?: string;
        resume?: string | boolean;
        listSessions?: boolean;
        planningModel?: string;
        planFirst?: boolean;
        preflight?: boolean;
        solve?: boolean;
        check?: string;
        solveAttempts?: string;
        repro?: string | boolean;
        reproPath?: string;
        telemetry?: string;
        sandbox?: string;
        contain?: boolean;
        yolo?: boolean;
        workspaceIsolation?: string;
        workspaceIsolationIncludeDirty?: boolean;
        tui?: boolean;
        print?: boolean;
      },
    ) => {
    const baseConfig = loadConfig({
      ...(opts.mode ? { approvalMode: opts.mode as ApprovalMode } : {}),
      ...(opts.planningModel ? { reasonerModel: opts.planningModel } : {}),
      ...(opts.planFirst ? { planFirst: true } : {}),
      ...(opts.solve ? { solve: true } : {}),
      ...(opts.check ? { solveCheck: opts.check } : {}),
      ...(opts.solveAttempts && Number.isFinite(Number(opts.solveAttempts))
        ? { solveMaxAttempts: Math.max(1, Math.trunc(Number(opts.solveAttempts))) }
        : {}),
      // Bare `--repro` means auto; `--repro off` (or absent) leaves it off.
      ...(opts.repro === true || opts.repro === "auto" ? { solveRepro: "auto" as const } : {}),
      ...(opts.reproPath ? { solveReproPath: opts.reproPath } : {}),
      ...(opts.telemetry ? { solveTelemetry: opts.telemetry } : {}),
      ...(opts.sandbox ? { sandbox: { mode: opts.sandbox as SandboxMode } } : {}),
      // --contain / --no-contain → commander gives opts.contain (boolean | undefined).
      // undefined leaves env/file to decide; a boolean makes the CLI win.
      ...(opts.contain !== undefined ? { containment: { enabled: opts.contain } } : {}),
      // --yolo: approval mode "yolo" (loadConfig forces containment on + escape hatches off).
      ...(opts.yolo ? { approvalMode: "yolo" as ApprovalMode } : {}),
      ...(opts.workspaceIsolation || opts.workspaceIsolationIncludeDirty
        ? {
            workspaceIsolation: {
              ...(opts.workspaceIsolation ? { mode: opts.workspaceIsolation as WorkspaceIsolationMode } : {}),
              ...(opts.workspaceIsolationIncludeDirty ? { includeDirty: true } : {}),
            },
          }
        : {}),
    });
    // Quarantine notice: --no-contain / --sandbox off|local are disabled for now
    // (gated behind DEEPCODER_ALLOW_UNCONTAINED=1). Tell the user they were ignored.
    const uncontainedAllowed = ["1", "true", "yes"].includes((process.env.DEEPCODER_ALLOW_UNCONTAINED ?? "").toLowerCase());
    if (!uncontainedAllowed && (opts.contain === false || opts.sandbox === "off" || opts.sandbox === "local")) {
      console.error(chalk.yellow(
        "Note: --no-contain / --sandbox off|local are disabled for now — workspace containment is enforced.",
      ));
    }
    // Phase 10S — fail closed early: containment is meaningless without bubblewrap.
    if (baseConfig.containment.enabled && !bwrapAvailable()) {
      console.error(chalk.red(
        "Workspace containment (--contain) requires bubblewrap (bwrap), which is not available here.\n" +
        "Install bubblewrap, or drop --contain to run without containment.",
      ));
      process.exit(1);
    }
    // Phase 10T — loud banner: yolo trades the classifier/prompt guardrail for the
    // sandbox guardrail, so make it unmistakable (and note --no-contain was ignored).
    if (baseConfig.approvalMode === "yolo") {
      console.error(chalk.yellow(
        "⚠ YOLO — auto-approving ALL actions; workspace containment FORCED ON; MCP-execute + interactive-shell disabled.",
      ));
      if (opts.contain === false) {
        console.error(chalk.yellow("  (--no-contain ignored: --yolo requires the sandbox as its safety net.)"));
      }
    }
    if (opts.preflight) baseConfig.context.preflight = true;

    if (opts.listSessions) {
      const all = await listSessions(baseConfig.workspaceRoot);
      if (all.length === 0) console.log(chalk.dim("No saved sessions."));
      else for (const s of all) console.log(`${s.id}  ${chalk.dim(`${s.messageCount} msgs · ${s.updatedAt}`)}`);
      return;
    }

    const session = await buildSession(baseConfig, opts.resume);
    await setupIsolation(session);

    const prompt = promptParts.join(" ").trim();
    try {
      if (prompt) await runOneShot(session, prompt, { print: opts.print });
      else {
        // Non-TTY never starts the TUI (resolveUiMode enforces this).
        const uiMode = resolveUiMode({
          flag: opts.tui === true ? "tui" : opts.tui === false ? "plain" : undefined,
          env: process.env,
          isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        });
        if (uiMode === "tui") await runTuiRepl(session);
        else await runRepl(session);
      }
    } finally {
      await finalizeIsolation(session);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exit(1);
});
