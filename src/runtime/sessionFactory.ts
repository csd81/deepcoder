import chalk from "chalk";
import os from "node:os";
import { stdin, stdout } from "node:process";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type PrContext } from "../config/config.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { composePluginChecks, composePluginSkills } from "../plugins/compose.js";
import type { PluginTrustStore } from "../plugins/trust.js";
import type { Plugin } from "../plugins/types.js";
import type { SkillSummary } from "../skills/types.js";
import { createIsolatedWorkspace, WorkspaceIsolationError } from "../workspaceIsolation/index.js";
import { confirm } from "../permissions/prompt.js";
import { createProvider } from "../providers/factory.js";
import { EMPTY_USAGE } from "../providers/usage.js";
import { createSemanticTools } from "../tools/semanticTools.js";
import { createWebTools } from "../tools/webTools.js";
import { createWebSearchProviderFromConfig } from "../web/providerFactory.js";
import { createPtyTools } from "../tools/ptyTools.js";
import { createLspTools } from "../tools/lspTools.js";
import { createLspManager } from "../lsp/manager.js";
import type { LspRuntime } from "../lsp/types.js";
import { defaultRegistry } from "../tools/registry.js";
import { discoverSkills } from "../skills/discovery.js";
import { buildSkillCatalog } from "../skills/catalogPrompt.js";
import { systemMessage, resolveInstructions, type Session } from "../cli/repl.js";
import { startFileWatcher } from "../workspace/fileWatcher.js";
import { initPlanMode } from "../cli/planMode.js";
import {
  SessionStore,
  newSessionId,
  loadSession,
  latestSessionId,
} from "../session/sessionStore.js";
import { McpManager } from "../mcp/registry.js";
import { CheckpointRecorder } from "../session/checkpoints.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Config } from "../config/config.js";
import type { AgentMessage } from "../providers/types.js";
import { ModelRouter } from "../models/router.js";
import { ProviderPool } from "../models/providerPool.js";
import { runSubagent } from "../subagents/runner.js";
import { PROFILES } from "../subagents/profiles.js";
import type { DelegateRuntime } from "../tools/types.js";

/** Connect configured MCP servers and register their tools. Returns undefined
 *  when none are configured; never throws (bad servers warn and are skipped). */
export async function initMcp(config: Config, registry: ToolRegistry): Promise<McpManager | undefined> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return undefined;
  const manager = new McpManager(config.mcpServers);
  await manager.connectAll();
  await manager.registerInto(registry);
  const bad = manager.status().filter((s) => s.error && s.error !== "disabled");
  for (const s of bad) console.error(chalk.yellow(`MCP server "${s.name}" unavailable: ${s.error}`));
  return manager;
}

/**
 * If workspace isolation is enabled, create a disposable git worktree and point
 * the session's EXECUTION root at it (file tools + checks). The control plane
 * (config, sessions, MCP) stays on config.workspaceRoot. A setup failure (non-git
 * / dirty tree) aborts the run rather than silently editing the live repo.
 */
export async function setupIsolation(session: Session): Promise<void> {
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
export async function finalizeIsolation(session: Session): Promise<void> {
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

/**
 * Phase 10D — compose TRUSTED plugins' named checks into config.checks so
 * `/check <plugin:name>` and `--check` can use them. Fail-closed on trust
 * (untrusted plugins contribute nothing) and best-effort on I/O (any error
 * leaves checks unchanged — composition must never break startup). Each
 * contributed check still runs through the classifier + runCheck gate.
 */
async function loadPluginTrustStore(workspaceRoot: string): Promise<PluginTrustStore> {
  try {
    return JSON.parse(
      await readFile(path.join(workspaceRoot, ".deepcoder", "plugin-trust.json"), "utf8"),
    ) as PluginTrustStore;
  } catch {
    return { plugins: {} }; // no/unreadable store → nothing trusted → nothing composed
  }
}

export async function composePluginContributions(config: Config): Promise<void> {
  try {
    const plugins = await discoverPlugins(config.workspaceRoot, os.homedir());
    if (plugins.length === 0) return;
    const store = await loadPluginTrustStore(config.workspaceRoot);
    const composed = composePluginChecks(plugins, store, config.checks);
    config.checks = composed.checks;
    if (composed.added.length) {
      stdout.write(chalk.dim(`plugins: composed ${composed.added.length} check(s): ${composed.added.join(", ")}\n`));
    }
  } catch {
    /* plugin composition is best-effort and must never break session startup */
  }
}

/**
 * Phase 10D — fold trusted plugins' skills into a discovered-skills list. Best
 * effort (returns the input unchanged on any error); fail-closed on trust and
 * path-safety inside composePluginSkills.
 */
async function composePluginSkillsInto(
  workspaceRoot: string,
  discovered: SkillSummary[],
): Promise<SkillSummary[]> {
  try {
    const plugins: Plugin[] = await discoverPlugins(workspaceRoot, os.homedir());
    if (plugins.length === 0) return discovered;
    const store = await loadPluginTrustStore(workspaceRoot);
    const composed = await composePluginSkills(plugins, store, discovered, {
      readFile: async (abs) => {
        try {
          return await readFile(abs, "utf8");
        } catch {
          return null;
        }
      },
    });
    if (composed.added.length) {
      stdout.write(chalk.dim(`plugins: composed ${composed.added.length} skill(s): ${composed.added.join(", ")}\n`));
    }
    return composed.skills;
  } catch {
    return discovered;
  }
}

/**
 * Build a DelegateRuntime for a running session. Closes over the session's
 * provider, model config, and subagent profiles to let the delegate tool run
 * read-only subagents. The runtime is deliberately NOT passed into subagent
 * ToolContexts (see runner.ts), preventing recursive/ nested delegation.
 */
export function buildDelegateRuntime(session: Session): DelegateRuntime {
  return {
    async run(profileName, task, signal) {
      const profileDef = PROFILES[profileName];
      if (!profileDef) {
        throw new Error(`Unknown subagent profile: ${profileName}`);
      }
      const { result } = await runSubagent(profileDef, task, {
        workspaceRoot: session.config.workspaceRoot,
        provider: session.provider,
        parentModel: session.config.model,
        subagentModel: session.config.subagentModel,
        contextBudgetTokens: session.config.contextBudgetTokens,
        compactAt: session.config.compactAt,
        modelRouter: session.modelRouter,
        providerPool: session.providerPool,
        signal: signal ?? new AbortController().signal,
      });
      return { summary: result.summary, findings: result.findings };
    },
  };
}

/**
 * Build a system message carrying the PR diff context so the model can review it.
 */
function injectPrContext(pr: PrContext): AgentMessage {
  return {
    role: "system",
    content: `Reviewing PR #${pr.number}.\n\nDiff:\n\`\`\`diff\n${pr.diff}\n\`\`\`\n\nThe PR branch (${pr.prBranch}) is checked out locally.`,
  };
}

export async function buildSession(
  config: ReturnType<typeof loadConfig>,
  resume?: string | boolean,
): Promise<Session> {
  await composePluginContributions(config);
  const provider = createProvider(config);
  const modelRouter = new ModelRouter(config, config.models);
  const providerPool = new ProviderPool(config);
  const registry = defaultRegistry();
  // Phase 8E: register the semantic tools only when opt-in is enabled (default off).
  if (config.semanticSearch.enabled) {
    for (const t of createSemanticTools({ config: config.semanticSearch })) registry.register(t);
  }
  // Phase 10E: register the web tools only when web is enabled (default off).
  for (const t of createWebTools({
    enabled: config.web.enabled,
    allowedDomains: config.web.allowedDomains,
    blockedDomains: config.web.blockedDomains,
    searchProvider: config.web.searchProvider,
    quarantine: config.web.quarantine,
    maxReturnedChars: config.web.maxReturnedChars,
    // Phase 10E6: resolve a concrete search backend (e.g. Brave) from config +
    // env; falls back to the refusing noneProvider when disabled/unset.
    provider: createWebSearchProviderFromConfig({ config: config.web, env: process.env }),
  })) registry.register(t);
  // Phase 10G: register the persistent interactive-shell tool only when opted in
  // (default off / fail-closed); it still flows through the permission policy.
  for (const t of createPtyTools({ enabled: config.interactiveShell })) registry.register(t);
  // LSP code-intelligence tools: only when opt-in is enabled (default off). The
  // manager lazily launches a server per language; closeAll() runs on session end.
  let lsp: LspRuntime | undefined;
  if (config.lsp.enabled) {
    lsp = createLspManager(config.lsp, config.workspaceRoot);
    for (const t of createLspTools(lsp)) registry.register(t);
  }
  const mcp = await initMcp(config, registry);
  const recorder = config.checkpoints === "off" ? undefined : new CheckpointRecorder(config.workspaceRoot);

  // Phase 7C2: a compact, bounded skills catalog injected into the startup system
  // prompt (advisory — skills must be explicitly activated). Empty when disabled.
  let skillsCatalog = "";
  if (config.skills.enabled) {
    const disabled = new Set(config.skills.disabled);
    let discovered = (await discoverSkills(config.workspaceRoot)).filter((s) => !disabled.has(s.name));
    // Phase 10D — trusted plugins may contribute additional skills (fail-closed).
    discovered = (await composePluginSkillsInto(config.workspaceRoot, discovered)).filter((s) => !disabled.has(s.name));
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
    const fresh = systemMessage(cfg, saved.mode, instr.text, skillsCatalog, registry.names());
    if (messages[0]?.role === "system") messages[0] = fresh;
    else messages.unshift(fresh);
    const resumedSession: Session = {
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
      lsp,
      recorder,
      instructionGraph: instr.graph,
      tokenUsage: { ...EMPTY_USAGE },
      telemetry: saved.telemetry,
      modelRouter,
      providerPool,
      planState: initPlanMode(),
      title: saved.title,
    };
    return resumedSession;
  }

  const instr = resolveInstructions(config);
  const messages: AgentMessage[] = [systemMessage(config, config.approvalMode, instr.text, skillsCatalog, registry.names())];
  // Inject PR context as a second system message when --pr or /pr loaded one.
  if (config.prContext) {
    messages.push(injectPrContext(config.prContext));
  }
  const freshSession: Session = {
    config,
    provider,
    registry,
    store: new SessionStore(config.workspaceRoot, newSessionId()),
    messages,
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
    lsp,
    recorder,
    instructionGraph: instr.graph,
    tokenUsage: { ...EMPTY_USAGE },
    modelRouter,
    providerPool,
    planState: initPlanMode(),
  };
  return freshSession;
}

/**
 * Start the external-file-change watcher for an interactive session and store
 * it on `session.fileWatcher`. Called ONLY by the REPL/TUI entry points (which
 * stop it on exit) — never by buildSession, so one-shot runs and tests don't
 * leak a recursive fs.watch handle that would keep the process alive at exit
 * (recursive watch ignores unref on Linux). Idempotent: no-op if already set.
 */
export function attachFileWatcher(session: Session): void {
  if (session.fileWatcher) return;
  const root = session.config.workspaceRoot;
  session.fileWatcher = startFileWatcher(root, (rel) => {
    // Only react to files the agent has actually READ (readTracker keys are the
    // absolute resolved paths). Anything else is noise we shouldn't surface or
    // act on — this keeps the notice rare and meaningful, not a per-save flood.
    const abs = path.resolve(root, rel);
    if (!session.readTracker.has(abs)) return;
    session.readTracker.delete(abs); // force a re-read next time the agent needs it
    stdout.write(chalk.dim(`file changed externally: ${rel}\n`));
  });
}
