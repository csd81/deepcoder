import chalk from "chalk";
import os from "node:os";
import { stdout } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type PrContext } from "../config/config.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { composePluginChecks, composePluginSkills } from "../plugins/compose.js";
import type { PluginTrustStore } from "../plugins/trust.js";
import type { Plugin } from "../plugins/types.js";
import type { SkillSummary } from "../skills/types.js";
import { createIsolatedWorkspace, WorkspaceIsolationError, DEFAULT_WORKSPACE_ISOLATION, isDirty } from "../workspaceIsolation/index.js";
import { finalizeToBranch } from "../workspaceIsolation/finalizeToBranch.js";
import { isWriteEffect } from "./writeEffect.js";
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
import { verifyFindings } from "../delegate/verifyFindings.js";
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
import { discoverCustomProfiles, mergeProfiles } from "../subagents/customProfiles.js";
import type { DelegateRuntime, DelegateAutoRuntime, WorktreeRuntime, ToolContext, ToolInvocation } from "../tools/types.js";
import { runDelegateAuto } from "../cli/delegateCli.js";

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

/** The branch a session commits its isolated changes onto. Session ids are
 *  filesystem-safe and unique per run, so parallel agents never collide. */
export function branchNameForSession(session: Session): string {
  return `deepcoder/${session.store.id}`;
}

function commitMessageForSession(session: Session): string {
  const title = session.title?.trim();
  const subject = title ? `deepcoder: ${title}` : `deepcoder session ${session.store.id}`;
  return (
    `${subject}\n\n` +
    "Automated changes from a deepcoder copy-on-write session.\n" +
    "NOT yet human-verified — review before merging.\n\n" +
    "Co-Authored-By: deepcoder <noreply@deepcoder.local>"
  );
}

function prBodyForSession(session: Session): string {
  return (
    `Automated changes from deepcoder session \`${session.store.id}\`` +
    (session.title ? ` — ${session.title}` : "") +
    ".\n\n" +
    "**Not yet human-verified.** Review before merging:\n" +
    "- [ ] Scope: only intended files changed\n" +
    "- [ ] Tests/checks pass on the merge result\n" +
    "- [ ] No secrets or generated artifacts committed\n"
  );
}

/**
 * After an isolated run, commit the worktree's changes onto a NEW branch off the
 * user's current branch and open a PR when a remote exists (otherwise leave the
 * committed branch locally for review). The user's checkout is NEVER modified and
 * the branch is NEVER merged. Then clean up the worktree unless configured to
 * keep it (or unless the branch step failed, so it can be inspected).
 */
export async function finalizeIsolation(session: Session): Promise<void> {
  const ws = session.isolation;
  if (!ws) return;
  const iso = session.config.workspaceIsolation;
  let ok = false;
  try {
    const res = await finalizeToBranch(ws, {
      realRoot: session.config.workspaceRoot,
      branch: branchNameForSession(session),
      commitMessage: commitMessageForSession(session),
      prBody: prBodyForSession(session),
    });
    ok = true;
    if (res.changedFiles === 0) {
      stdout.write(chalk.dim("\nworkspace isolation: no changes were made.\n"));
    } else if (res.prUrl) {
      stdout.write(
        chalk.green(`\nworkspace isolation — ${res.changedFiles} changed file(s) committed to ${res.branch}.\n`) +
          chalk.cyan(`opened PR: ${res.prUrl}\n`),
      );
    } else {
      stdout.write(
        chalk.green(`\nworkspace isolation — ${res.changedFiles} changed file(s) committed to branch ${res.branch}.\n`) +
          chalk.dim(`no PR opened (no remote or gh unavailable). review locally with:\n  git log ${res.branch}\n`),
      );
    }
  } catch (err) {
    stdout.write(
      chalk.red(`\nworkspace isolation: could not create the branch: ${(err as Error).message}\n`) +
        chalk.dim("the real workspace is unchanged; keeping the isolated workspace for inspection.\n"),
    );
  } finally {
    const keep = ok ? iso.keepOnSuccess : iso.keepOnFailure;
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
      const profileDef = session.profiles[profileName];
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
      let findings = result.findings;
      if (session.config.delegate?.verify?.enabled !== false && findings.length > 0) {
        try {
          findings = await verifyFindings(findings, {
            workspaceRoot: session.config.workspaceRoot,
            provider: session.provider,
            parentModel: session.config.model,
            subagentModel: session.config.subagentModel,
            modelRouter: session.modelRouter,
            providerPool: session.providerPool,
            contextBudgetTokens: session.config.contextBudgetTokens,
            compactAt: session.config.compactAt,
            signal: signal ?? new AbortController().signal,
          });
        } catch {
          // fail-safe: on error, findings stay as-is (unverified)
        }
      }
      return { summary: result.summary, findings };
    },
  };
}

/**
 * Build a WorktreeRuntime for a running session. Closes over the session's
 * workspace isolation lifecycle so the model-callable enter/exit_worktree tools
 * can create and manage a disposable git worktree. Uses the same
 * createIsolatedWorkspace machinery as --workspace-isolation, but does NOT wire
 * into the session's automatic setup/finalize lifecycle — the model controls
 * enter and exit explicitly.
 */
export function buildWorktreeRuntime(session: Session): WorktreeRuntime {
  return {
    isActive() {
      return session.isolation !== undefined;
    },
    async enter() {
      const ws = await createIsolatedWorkspace(session.config.workspaceRoot, {
        ...DEFAULT_WORKSPACE_ISOLATION,
        mode: "patch",
      });
      session.isolation = ws;
      session.executionRoot = ws.isolatedRoot;
      return { isolatedRoot: ws.isolatedRoot };
    },
    async exit(action: "apply" | "discard") {
      const ws = session.isolation;
      if (!ws) return { changed: 0, applied: false };
      const files = await ws.changedFiles();
      const changed = files.length;
      let applied = false;
      if (action === "apply" && changed > 0) {
        try {
          await ws.applyPatchToRealRoot({ force: false });
          applied = true;
        } catch {
          applied = false;
        }
      }
      await ws.cleanup();
      session.isolation = undefined;
      session.executionRoot = session.config.workspaceRoot;
      return { changed, applied };
    },
  };
}

/**
 * Rekey absolute-path trackers from oldRoot to newRoot, in place. readTracker
 * and writeTracker keys are absolute lexical paths under the OLD root (readFile.ts
 * adds resolveInWorkspace(ctx.workspaceRoot, path)). After a copy-on-write root
 * switch, edit_file's read-before-write check (editFile.ts) must still find a
 * file that was read pre-switch, so its key has to follow the root. Foreign keys
 * (outside oldRoot) are preserved. Sets are mutated in place because
 * session.readTracker and ctx.readTracker are the SAME Set reference.
 */
export function rekeyTrackers(ctx: ToolContext, oldRoot: string, newRoot: string): void {
  for (const set of [ctx.readTracker, ctx.writeTracker]) {
    if (!set) continue;
    const remapped: string[] = [];
    for (const k of set) {
      remapped.push(
        k === oldRoot || k.startsWith(oldRoot + path.sep) ? newRoot + k.slice(oldRoot.length) : k,
      );
    }
    set.clear();
    for (const k of remapped) set.add(k);
  }
}

/**
 * Build the copy-on-write callback for a live session and its live ToolContext.
 * On the FIRST write-effect tool (see isWriteEffect), it lazily creates a
 * disposable worktree and mutates the shared ctx in place so this and every
 * later tool in the turn writes into the worktree, never the user's checkout:
 *   - ctx.workspaceRoot → the isolated worktree root
 *   - readTracker/writeTracker rekeyed to the new root
 *   - checkpoint capture disabled (the worktree is the undo boundary)
 *   - provisioned dep symlinks bound read-only into the sandbox (mirrors setupIsolation)
 * Idempotent: once session.isolation is set it is a no-op. Throws (turned into a
 * recoverable tool-result by the agent loop) when the real tree is dirty — CoW
 * needs a clean base to branch from, and we must not sweep the user's unsaved
 * edits onto the agent's branch.
 */
export function buildEnsureWritableRoot(
  session: Session,
  ctx: ToolContext,
): (inv: ToolInvocation) => Promise<void> {
  return async (inv: ToolInvocation): Promise<void> => {
    if (session.isolation) return; // already isolated (eager setup or a prior lazy entry)
    if (!isWriteEffect(inv)) return; // read-only / session tool — never provision
    const realRoot = session.config.workspaceRoot;
    if (isDirty(realRoot)) {
      throw new Error(
        "the working tree has uncommitted changes; commit or stash them before the agent " +
          "writes (copy-on-write needs a clean base to branch from).",
      );
    }
    const ws = await createIsolatedWorkspace(realRoot, {
      ...DEFAULT_WORKSPACE_ISOLATION,
      mode: "patch",
    });
    session.isolation = ws;
    session.executionRoot = ws.isolatedRoot;
    // Redirect the live ctx — every later execute(ctx) reads ctx.workspaceRoot fresh.
    rekeyTrackers(ctx, realRoot, ws.isolatedRoot);
    ctx.workspaceRoot = ws.isolatedRoot;
    // The worktree is now the undo boundary; checkpointing keyed to the real root
    // no longer applies.
    ctx.capturePreImage = undefined;
    ctx.recordPostWrite = undefined;
    // Compose with the sandbox (mirror setupIsolation): provisioned dep symlinks
    // point OUTSIDE the worktree, so sandboxed commands need their targets bound RO.
    const sb = session.config.sandbox;
    if (sb.mode !== "off" && ws.provisioned.length) {
      for (const { target } of ws.provisioned) {
        if (!sb.extraMounts.some((m) => m.path === target)) sb.extraMounts.push({ path: target, mode: "ro" });
      }
    }
    session.onLazyWorktree?.(ws.isolatedRoot);
  };
}

/**
 * Build a DelegateAutoRuntime for a running session. Wraps runDelegateAuto so
 * the delegate tool never imports the CLI module directly. The runtime is
 * deliberately NOT passed into subagent ToolContexts, preventing nested
 * autonomous delegation.
 */
export function buildDelegateAutoRuntime(session: Session): DelegateAutoRuntime {
  return {
    async runAuto(task, opts) {
      return runDelegateAuto(session.config.workspaceRoot, task, {
        concurrent: opts?.concurrent,
        noPr: opts?.noPr,
        base: opts?.base,
      });
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

  const customProfs = await discoverCustomProfiles(config.workspaceRoot);
  const mergedProfiles = mergeProfiles(PROFILES, customProfs);

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
      profiles: mergedProfiles,
      briefs: saved.briefs ?? [],
      plans: saved.plans ?? [],
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
    profiles: mergedProfiles,
    briefs: [],
    plans: [],
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
