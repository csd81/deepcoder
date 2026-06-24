#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type ApprovalMode, VALID_APPROVAL_MODES } from "../config/config.js";
import { type SandboxMode, VALID_SANDBOX_MODES } from "../sandbox/types.js";
import { bwrapAvailable } from "../sandbox/index.js";
import { type WorkspaceIsolationMode, VALID_ISOLATION_MODES } from "../workspaceIsolation/types.js";
import { runOneShot, runRepl, runTuiRepl } from "./repl.js";
import { resolveUiMode } from "../ui/uiMode.js";
import { listSessions, forkSession, latestSessionId } from "../session/sessionStore.js";
import { buildSession, setupIsolation, finalizeIsolation } from "../runtime/sessionFactory.js";
import { resolveAutoModel } from "../models/autoModel.js";
import { fetchPr, getPrDiff } from "./prFetch.js";
import { Git } from "../workspace/git.js";
import { DeepcoderClient } from "../sdk/client.js";
import { createStdioTransport } from "../server/index.js";
import { createAgentRunner } from "../server/agentRunner.js";
import { registerDelegateCommand } from "./delegateCli.js";
import { registerAuditSweepCommand } from "./auditSweepCli.js";

const program = new Command();

program
  .name("deepcoder")
  .description("A small, model-agnostic agentic coding CLI (DeepSeek).")
  .argument("[prompt...]", "task to run once and exit; omit for interactive mode")
  .option("--mode <mode>", "approval mode: ask | auto | readonly | yolo")
  .option("--resume [id]", "resume a saved session (most recent if id omitted)")
  .option("--fork", "fork the session when resuming (copies to a new id)")
  .option("--list-sessions", "list saved sessions and exit")
  .option("--archived", "include archived sessions in --list-sessions")
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
  .option("--no-contain", "disable workspace containment (runs without bubblewrap; ignored under --yolo)")
  .option("--yolo", "approve ALL actions within the workspace — no prompts; forces containment ON and disables the MCP-execute + interactive-shell escape hatches")
  .option("--workspace-isolation <mode>", "isolate file edits in a git worktree: off | patch | keep")
  .option("--workspace-isolation-include-dirty", "allow isolation despite a dirty repo (works against HEAD; uncommitted changes are NOT included in the worktree)")
  .option("--tui", "interactive: use the experimental scrollable terminal UI (TTY only)")
  .option("--no-tui", "interactive: force the plain line UI")
  .option("--title <name>", "set a session title")
  .option("--pr <number>", "fetch a GitHub PR (by number) and start a session with its diff")
  .option("--remote <name>", "remote name for --pr (default: origin)")
  .option("-p, --print", "one-shot: print only the raw assistant reply (no chrome) and exit")
  .option("--serve", "run a persistent JSON-RPC stdio server (newline-delimited): one live session, multi-turn, streams events to stdout. For testing/integration.")
  .action(
    async (
      promptParts: string[],
      opts: {
        mode?: string;
        resume?: string | boolean;
        fork?: boolean;
        listSessions?: boolean;
        archived?: boolean;
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
        title?: string;
        pr?: string;
        remote?: string;
        print?: boolean;
        serve?: boolean;
      },
    ) => {
    // Validate CLI enum values before passing to loadConfig
    if (opts.mode && !(VALID_APPROVAL_MODES as readonly string[]).includes(opts.mode)) {
      console.error(chalk.red(`Invalid approval mode "${opts.mode}". Use one of: ${VALID_APPROVAL_MODES.join(" | ")}`));
      process.exit(1);
    }
    if (opts.sandbox && !(VALID_SANDBOX_MODES as readonly string[]).includes(opts.sandbox)) {
      console.error(chalk.red(`Invalid sandbox mode "${opts.sandbox}". Use one of: ${VALID_SANDBOX_MODES.join(" | ")}`));
      process.exit(1);
    }
    if (opts.workspaceIsolation && !(VALID_ISOLATION_MODES as readonly string[]).includes(opts.workspaceIsolation)) {
      console.error(chalk.red(`Invalid workspace isolation mode "${opts.workspaceIsolation}". Use one of: ${VALID_ISOLATION_MODES.join(" | ")}`));
      process.exit(1);
    }
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

    // Proactive, up-front model selection (plans/new/feat-auto-model-selection-plan.md):
    // for a one-shot task, when the model wasn't pinned explicitly and auto-selection
    // is on, score the task's complexity BEFORE the session starts and prefer the
    // cheaper Flash unless it genuinely needs Pro. Reactive escalation (escalation.ts)
    // remains the safety net; interactive turns vary per prompt so they rely on it.
    const oneShotPrompt = promptParts.join(" ").trim();
    if (oneShotPrompt && baseConfig.modelAuto && !baseConfig.modelExplicit) {
      const picked = resolveAutoModel({
        signals: { prompt: oneShotPrompt },
        modelAuto: true,
        flashModel: baseConfig.model,
        proModel: baseConfig.reasonerModel ?? baseConfig.model,
      });
      if (picked.model !== baseConfig.model) {
        baseConfig.model = picked.model;
        console.error(chalk.dim(`model: auto-selected ${picked.model} — ${picked.reasons[picked.reasons.length - 1]}`));
      }
    }

    if (opts.listSessions) {
      const all = await listSessions(baseConfig.workspaceRoot, { includeArchived: !!opts.archived });
      if (all.length === 0) console.log(chalk.dim("No saved sessions."));
      else for (const s of all) {
        const label = s.title ? `${s.title} ${chalk.dim(`(${s.id})`)}` : s.id;
        console.log(`${label}  ${chalk.dim(`${s.messageCount} msgs · ${s.updatedAt}`)}`);
      }
      return;
    }

    // --fork: resolve the resume id, fork it, and resume the copy.
    let resumeArg: string | boolean | undefined = opts.resume;
    if (opts.resume && opts.fork) {
      const resolvedId = typeof opts.resume === "string" ? opts.resume : await latestSessionId(baseConfig.workspaceRoot);
      if (!resolvedId) throw new Error("No saved session to fork/resume.");
      resumeArg = await forkSession(baseConfig.workspaceRoot, resolvedId);
    }

    if (opts.pr) {
      const prInfo = await fetchPr(Number(opts.pr), { remote: opts.remote, workspaceRoot: baseConfig.workspaceRoot });
      const diff = await getPrDiff(new Git(baseConfig.workspaceRoot), prInfo);
      baseConfig.prContext = { number: opts.pr, diff, prBranch: prInfo.prBranch };
    }

    const session = await buildSession(baseConfig, resumeArg);
    if (opts.title) {
      session.title = opts.title;
    }
    await setupIsolation(session);

    // Persistent stdio server: one live in-memory session, multi-turn. Read
    // newline-delimited JSON-RPC from stdin, stream events/results to stdout.
    if (opts.serve) {
      const client = new DeepcoderClient({ runner: createAgentRunner(session) });
      const transport = createStdioTransport({ client, write: (line) => process.stdout.write(line) });
      process.stdin.setEncoding("utf8");
      await new Promise<void>((resolve) => {
        process.stdin.on("data", (c: string) => { void transport.push(c); });
        process.stdin.on("end", () => { void transport.end().finally(resolve); });
        process.stdin.on("close", () => resolve());
      });
      return;
    }

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

// Headless delegation subcommand (`deepcoder delegate validate|…`). Registered
// as a sibling to the default prompt action; runs the built-in pipeline's real
// validation gates without a TTY. See plans/new/feat-headless-delegate-cli-plan.md.
registerDelegateCommand(program);

// `deepcoder audit sweep` — composes the delegate pipeline into the hands-off
// self-maintenance loop (audit → triage → fix → merge). See
// plans/new/feat-scheduled-audit-fix-merge-plan.md.
registerAuditSweepCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red((err as Error).message ?? String(err)));
  process.exit(1);
});
