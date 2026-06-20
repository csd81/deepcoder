#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { stdin, stdout } from "node:process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type ApprovalMode } from "../config/config.js";
import type { SandboxMode } from "../sandbox/types.js";
import type { WorkspaceIsolationMode } from "../workspaceIsolation/types.js";
import { createIsolatedWorkspace, WorkspaceIsolationError } from "../workspaceIsolation/index.js";
import { confirm } from "../permissions/prompt.js";
import { createProvider } from "../providers/factory.js";
import { EMPTY_USAGE } from "../providers/usage.js";
import { createSemanticTools } from "../tools/semanticTools.js";
import { defaultRegistry } from "../tools/registry.js";
import { discoverSkills } from "../skills/discovery.js";
import { buildSkillCatalog } from "../skills/catalogPrompt.js";
import { runOneShot, runRepl, systemMessage, resolveInstructions, type Session } from "./repl.js";
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
import { ModelRouter } from "../models/router.js";
import { ProviderPool } from "../models/providerPool.js";

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
  .option("--workspace-isolation <mode>", "isolate file edits in a git worktree: off | patch | keep")
  .option("--workspace-isolation-include-dirty", "allow isolation even when the repo has uncommitted changes")
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
        workspaceIsolation?: string;
        workspaceIsolationIncludeDirty?: boolean;
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
      ...(opts.workspaceIsolation || opts.workspaceIsolationIncludeDirty
        ? {
            workspaceIsolation: {
              ...(opts.workspaceIsolation ? { mode: opts.workspaceIsolation as WorkspaceIsolationMode } : {}),
              ...(opts.workspaceIsolationIncludeDirty ? { includeDirty: true } : {}),
            },
          }
        : {}),
    });
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
      if (prompt) await runOneShot(session, prompt);
      else await runRepl(session);
    } finally {
      await finalizeIsolation(session);
    }
  });

async function buildSession(
  config: ReturnType<typeof loadConfig>,
  resume?: string | boolean,
): Promise<Session> {
  const provider = createProvider(config);
  const modelRouter = new ModelRouter(config, config.models);
  const providerPool = new ProviderPool(config);
  const registry = defaultRegistry();
  // Phase 8E: register the semantic tools only when opt-in is enabled (default off).
  if (config.semanticSearch.enabled) {
    for (const t of createSemanticTools({ config: config.semanticSearch })) registry.register(t);
  }
  const mcp = await initMcp(config, registry);
  const recorder = config.checkpoints === "off" ? undefined : new CheckpointRecorder(config.workspaceRoot);

  // Phase 7C2: a compact, bounded skills catalog injected into the startup system
  // prompt (advisory — skills must be explicitly activated). Empty when disabled.
  let skillsCatalog = "";
  if (config.skills.enabled) {
    const disabled = new Set(config.skills.disabled);
    const discovered = (await discoverSkills(config.workspaceRoot)).filter((s) => !disabled.has(s.name));
    skillsCatalog = buildSkillCatalog(discovered, config.skills.catalogMaxChars);
  }

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
    const instr = resolveInstructions(cfg);
    const messages = saved.messages.slice();
    const fresh = systemMessage(cfg, saved.mode, instr.text, skillsCatalog);
    if (messages[0]?.role === "system") messages[0] = fresh;
    else messages.unshift(fresh);
    return {
      config: cfg,
      provider,
      registry,
      store: new SessionStore(config.workspaceRoot, id, saved.createdAt),
      messages,
      mode: saved.mode,
      executionRoot: config.workspaceRoot,
      todos: saved.todos,
      readTracker: new Set(saved.readTracker),
      writeTracker: new Set(saved.writeTracker ?? []),
      reviews: saved.reviews ?? [],
      briefs: saved.briefs ?? [],
      activatedSkills: saved.activatedSkills ?? [],
      trustedWorkspaceSkills: new Set<string>(),
      mcp,
      recorder,
      instructionGraph: instr.graph,
      tokenUsage: { ...EMPTY_USAGE },
      modelRouter,
      providerPool,
    };
  }

  const instr = resolveInstructions(config);
  return {
    config,
    provider,
    registry,
    store: new SessionStore(config.workspaceRoot, newSessionId()),
    messages: [systemMessage(config, config.approvalMode, instr.text, skillsCatalog)],
    mode: config.approvalMode,
    executionRoot: config.workspaceRoot,
    todos: [],
    readTracker: new Set<string>(),
    writeTracker: new Set<string>(),
    reviews: [],
    briefs: [],
    activatedSkills: [],
    trustedWorkspaceSkills: new Set<string>(),
    mcp,
    recorder,
    instructionGraph: instr.graph,
    tokenUsage: { ...EMPTY_USAGE },
    modelRouter,
    providerPool,
  };
}

/**
 * If workspace isolation is enabled, create a disposable git worktree and point
 * the session's EXECUTION root at it (file tools + checks). The control plane
 * (config, sessions, MCP) stays on config.workspaceRoot. A setup failure (non-git
 * / dirty tree) aborts the run rather than silently editing the live repo.
 */
async function setupIsolation(session: Session): Promise<void> {
  const iso = session.config.workspaceIsolation;
  if (iso.mode === "off") return;
  try {
    const ws = await createIsolatedWorkspace(session.config.workspaceRoot, iso);
    session.isolation = ws;
    session.executionRoot = ws.isolatedRoot;
    // Compose with the sandbox (7A): provisioned dep symlinks point OUTSIDE the
    // worktree, so when commands are sandboxed the targets must be bound read-only
    // for the symlinks to resolve inside bwrap.
    const sb = session.config.sandbox;
    if (sb.mode !== "off" && ws.provisioned.length) {
      for (const { target } of ws.provisioned) {
        if (!sb.extraMounts.some((m) => m.path === target)) sb.extraMounts.push({ path: target, mode: "ro" });
      }
    }
    stdout.write(
      chalk.cyan(`workspace isolation: ${iso.mode}\n`) +
        chalk.dim(
          `isolated workspace: ${ws.isolatedRoot}\n` +
            (ws.provisioned.length ? `provisioned: ${ws.provisioned.map((p) => path.basename(p.link)).join(", ")}\n` : "") +
            "the real repo changes only if you apply the patch\n",
        ),
    );
  } catch (err) {
    if (err instanceof WorkspaceIsolationError) {
      throw new Error(`Workspace isolation: ${err.message}`);
    }
    throw err;
  }
}

/**
 * After an isolated run, present the patch and either apply it (interactive
 * confirm) or, in non-TTY/headless mode, write a patch artifact and refuse to
 * auto-apply — so CI never silently mutates the live tree. Then clean up unless
 * configured to keep the workspace.
 */
async function finalizeIsolation(session: Session): Promise<void> {
  const ws = session.isolation;
  if (!ws) return;
  const iso = session.config.workspaceIsolation;
  let applied = false;
  try {
    const changed = await ws.changedFiles();
    if (changed.length === 0) {
      stdout.write(chalk.dim("\nworkspace isolation: no changes were made.\n"));
      return;
    }
    stdout.write(chalk.bold(`\nworkspace isolation — ${changed.length} changed file(s):\n`));
    for (const f of changed) stdout.write(`  ${f}\n`);

    if (!stdin.isTTY) {
      // Headless: never auto-apply. Persist a patch artifact under the REAL root.
      const artifact = path.join(session.config.workspaceRoot, ".deepcoder", `isolation-${session.store.id}.patch`);
      await writeFile(artifact, await ws.diff(), "utf8");
      stdout.write(
        chalk.yellow(`\nnot applied (headless). patch written to:\n  ${artifact}\n`) +
          chalk.dim(`apply with: git apply --whitespace=nowarn "${artifact}"\n`),
      );
      return;
    }

    const ok = await confirm("Apply this patch to the real workspace?");
    if (!ok) {
      stdout.write(chalk.dim("discarded — the real workspace is unchanged.\n"));
      return;
    }
    try {
      await ws.applyPatchToRealRoot({ force: false });
      applied = true;
      stdout.write(chalk.green("applied to the real workspace.\n"));
    } catch (err) {
      stdout.write(
        chalk.red(`\napply failed: ${(err as Error).message}\n`) +
          chalk.dim("the real workspace is unchanged; keeping the isolated workspace for inspection.\n"),
      );
    }
  } finally {
    const keep = applied ? iso.keepOnSuccess : iso.keepOnFailure;
    if (iso.mode === "keep" || keep) {
      stdout.write(chalk.dim(`isolated workspace kept at: ${ws.isolatedRoot}\n`));
    } else {
      await ws.cleanup();
    }
  }
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
