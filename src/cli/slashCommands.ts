import { promises as fs, openSync, readSync, fstatSync, closeSync } from "node:fs";
import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { estimateCost } from "../providers/pricing.js";
import { Git } from "../workspace/git.js";
import { resolveReadPathInWorkspace, displayPath, assertSafeId } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeRepo } from "../context/understand.js";
import { computeRepoKey, readUnderstandCache, writeUnderstandCache } from "../context/understandCache.js";
import os from "node:os";
import { discoverPlugins } from "../plugins/discovery.js";
import { summarizeWebTrace } from "../web/trace.js";
import { buildSemanticIndex } from "../semantic/indexer.js";
import { createEmbeddingProvider } from "../semantic/provider.js";
import { pluginTrustKey, resolvePluginTrust, applyTrust, type PluginTrustStore } from "../plugins/trust.js";
import { renderTodos } from "../tools/todoWrite.js";
import type { HookEvent } from "../hooks/types.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { compactIfNeeded } from "../context/compaction.js";
import {
  setGoal,
  updateGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  renderGoal,
  type SessionGoal,
} from "../session/goal.js";
import { loadSession, type PersistedSession } from "../session/sessionStore.js";
import { listCheckpoints, rollback } from "../session/checkpoints.js";
import { loadCheckRun, listCheckRuns } from "../session/checkRuns.js";
import { runSubagent } from "../subagents/runner.js";
import { reviewer, researcher, testTriage } from "../subagents/profiles.js";
import { runExplorer } from "../subagents/contextExplorer.js";
import { buildDeterministicPlan } from "../context/contextPlanner.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";
import { activityRegistry, runPsSlash, runStopSlash } from "../runtime/activityRegistry.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { buildTestTargetPlan } from "../checks/testTargetPlanner.js";
import { runTargetedChecks } from "../checks/targetedCheck.js";
import { resolveBackend } from "../sandbox/index.js";
import { discoverSkills } from "../skills/discovery.js";
import { loadStartupMemory, listTopics, remember, forget, loadInbox, acceptMemory, rejectMemory } from "../memory/store.js";
import { buildRepoIndex } from "../index/scanner.js";
import { impactedBy, reverseGraph } from "../index/impact.js";
import { relevantTests } from "../index/testTargeting.js";
import { findReferences } from "../index/references.js";
import { saveIndex, loadIndex, ensureIndex } from "../index/store.js";
import { runDoctor, formatDoctorReport } from "../doctor/doctor.js";
import type { SandboxMode } from "../sandbox/types.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { confirm } from "../permissions/prompt.js";
import { runSolveCommand } from "./solveRunner.js";
import { stdout } from "node:process";
import type { SubagentProfile, SubagentResult, SubagentTrace } from "../subagents/types.js";
import type { AgentMessage } from "../providers/types.js";
import type { Session } from "./repl.js";
import { resolveInstructions, skillsRuntime } from "./repl.js";
import { activateSkill } from "../skills/activation.js";
import {
  emptySessionModelOverrides,
  parseModelTarget,
  isValidRole,
  isValidEffort,
  applyModelOverride,
  applyEffortOverride,
  clearModelOverride,
  clearEffortOverride,
} from "../models/sessionOverrides.js";
import type { SessionModelOverrides } from "../models/sessionOverrides.js";
import type { ModelRole } from "../models/types.js";
import { ALL_ROLES } from "../models/types.js";
import { buildPlan } from "../delegate/planner.js";
import { buildContextAwarePlan } from "../delegate/contextPlan.js";
import { savePlan, loadPlan } from "../delegate/store.js";
import { runWorker, delegateDepthFromEnv, type WorkerModelOverride } from "../delegate/workerRunner.js";
import { runWorkerTdd } from "../delegate/tdd.js";
import { readTddRecord } from "../delegate/tddArtifacts.js";
import { applyWorker, discardWorker } from "../delegate/apply.js";
import { autoApplyIfEligible } from "../delegate/autoApply.js";
import { runAutopilot, readAutopilotArtifact } from "../delegate/autopilot.js";
import { runRunnable, runRunnableConcurrent, detectFileConflicts } from "../delegate/orchestrator.js";
import { getDelegationReviewOverview, getWorkerReviewDetail, previewApplyGates } from "../delegate/reviewBrowser.js";
import { renderReviewOverview, renderWorkerReview, renderPatchStat, renderGatePreview } from "../delegate/reviewRender.js";
import { runReviewUi, runReviewPicker } from "./reviewUi.js";
import { resolveUiMode } from "../ui/uiMode.js";
import { loadWorkerArtifacts } from "../delegate/artifacts.js";
import type { WorkerRun, DelegationPlan, WorkerTask } from "../delegate/types.js";
import { proposeFeatures, renderProposals } from "../delegate/propose.js";
import type { ProposalScope } from "../delegate/propose.js";
import { parseCopyArgs, extractLatestAssistant, extractLatestCodeBlock, type CopyPayload } from "../clipboard/copyTargets.js";
import { copyToClipboard } from "../clipboard/clipboard.js";
import { redactSecrets } from "../workspace/redact.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SlashOutcome {
  consumed: boolean;
  exit?: boolean;
}

const MODES: ApprovalMode[] = ["ask", "auto", "readonly"];

/**
 * Phase 9M — load + validate a deliverable coverage manifest from a workspace
 * file. Shape: { deliverables: [{ id, acceptance }], testCommand, allowedTestPaths? }.
 * The manifest is the spec checklist (ids + acceptance), NOT seeded test code.
 */
type LoadedManifest =
  | { ok: true; deliverables: { id: string; acceptance: string }[]; testCommand: string; allowedTestPaths?: string[] }
  | { ok: false; error: string };

export async function loadCoverageManifest(root: string, relPath: string): Promise<LoadedManifest> {
  let abs: string;
  try {
    abs = resolveReadPathInWorkspace(root, relPath);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return { ok: false, error: `cannot read ${relPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  const testCommand = obj.testCommand;
  if (typeof testCommand !== "string" || testCommand.trim().length === 0) {
    return { ok: false, error: "missing string `testCommand`" };
  }
  if (!Array.isArray(obj.deliverables) || obj.deliverables.length === 0) {
    return { ok: false, error: "missing non-empty `deliverables` array" };
  }
  const deliverables: { id: string; acceptance: string }[] = [];
  const seen = new Set<string>();
  for (const d of obj.deliverables) {
    const id = (d as Record<string, unknown>)?.id;
    const acceptance = (d as Record<string, unknown>)?.acceptance;
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id)) {
      return { ok: false, error: `deliverable id must match [A-Za-z0-9._-]+ (got ${JSON.stringify(id)})` };
    }
    if (seen.has(id)) return { ok: false, error: `duplicate deliverable id "${id}"` };
    seen.add(id);
    deliverables.push({ id, acceptance: typeof acceptance === "string" ? acceptance : "" });
  }
  const allowedTestPaths = Array.isArray(obj.allowedTestPaths)
    ? obj.allowedTestPaths.filter((x): x is string => typeof x === "string")
    : undefined;
  return { ok: true, deliverables, testCommand, allowedTestPaths };
}

/**
 * Handle a `/command`. Returns consumed=false if the input wasn't a slash
 * command (so the REPL should treat it as a prompt).
 */
export async function handleSlashCommand(
  input: string,
  session: Session,
  save: () => Promise<void>,
  runAgent?: () => Promise<void>,
): Promise<SlashOutcome> {
  if (!input.startsWith("/")) return { consumed: false };

  // Phase 7C2: `/$<skill-name> [arguments]` shorthand for `/skills activate`.
  // Detected before the normal command switch.
  if (input.startsWith("/$")) {
    const body = input.slice(2).trim();
    const sp = body.indexOf(" ");
    const name = sp === -1 ? body : body.slice(0, sp);
    const skillArgs = sp === -1 ? "" : body.slice(sp + 1).trim();
    if (!name) {
      console.log(chalk.dim("usage: /$<skill-name> [arguments]"));
      return { consumed: true };
    }
    await activateSkillSlash(session, name, skillArgs);
    return { consumed: true };
  }

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const { config } = session;

  switch (cmd) {
    case "exit":
    case "quit":
      return { consumed: true, exit: true };

    case "clear":
      session.messages.length = 1; // keep the system prompt
      session.todos.length = 0;
      console.log(chalk.dim("Conversation and todos cleared."));
      return { consumed: true };

    case "understand":
      await runUnderstand(session);
      return { consumed: true };

    case "semantic":
      await runIndex(session);
      return { consumed: true };

    case "plugins":
      await runPlugins(session, arg);
      return { consumed: true };

    case "web": {
      const w = config.web;
      console.log(chalk.bold("\nWeb access ") + (w.enabled ? chalk.green("enabled") : chalk.dim("disabled")));
      console.log(chalk.dim(`  provider: ${w.searchProvider} · allowed: ${w.allowedDomains.join(", ") || "(any non-blocked)"} · blocked: ${w.blockedDomains.length}`));
      console.log(chalk.dim("  trace:"));
      console.log(summarizeWebTrace(session.webTrace ?? []).split("\n").map((l) => "    " + l).join("\n"));
      return { consumed: true };
    }

    case "mode":
      if (MODES.includes(arg as ApprovalMode)) {
        session.mode = arg as ApprovalMode;
        console.log(chalk.dim(`Approval mode: ${session.mode}`));
      } else {
        console.log(chalk.dim(`Current mode: ${session.mode}. Use one of: ${MODES.join(", ")}`));
      }
      return { consumed: true };

    case "todos":
      console.log(renderTodos(session.todos));
      return { consumed: true };

    case "instructions": {
      // Phase 8A: with the instruction graph active, `/instructions` gains
      // inspection subcommands (show | sources | conflicts | reload). Without
      // it, keep the legacy first-match display.
      if (session.instructionGraph) {
        printInstructionGraph(session, rest[0]?.trim().toLowerCase() || "show");
        return { consumed: true };
      }
      const { source, text } = loadInstructions(config.workspaceRoot);
      if (source) console.log(chalk.dim(`(${source})\n`) + text);
      else console.log(chalk.dim("No project instructions found (.deepcoder/instructions.md, AGENTS.md, CLAUDE.md)."));
      return { consumed: true };
    }

    case "save":
      await save();
      console.log(chalk.dim(`Saved session ${session.store.id}`));
      return { consumed: true };

    case "usage": {
      const u = session.tokenUsage;
      const est = estimateCost(u, { provider: config.provider, model: config.model, pricing: config.telemetry.pricing });
      const costStr = est.pricingKnown ? ` · est ~$${est.totalUsd.toFixed(4)} (${est.rateLabel})` : " · cost: pricing unknown";
      console.log(
        chalk.dim(
          `Session tokens — total ${u.totalTokens} (prompt ${u.promptTokens}, completion ${u.completionTokens})${config.telemetry.costs ? costStr : ""}. ` +
            `Provider-reported estimate; not a remote quota.`,
        ),
      );
      return { consumed: true };
    }

    case "cost": {
      const u = session.tokenUsage;
      const est = estimateCost(u, { provider: config.provider, model: config.model, pricing: config.telemetry.pricing });
      if (!est.pricingKnown) {
        console.log(chalk.dim(`Cost: pricing unknown for ${config.provider}/${config.model} — showing tokens only (total ${u.totalTokens}).`));
      } else {
        console.log(chalk.dim(
          `Estimated cost (${est.rateLabel}): ~$${est.totalUsd.toFixed(4)} ` +
            `(input ~$${est.inputUsd.toFixed(4)}, output ~$${est.outputUsd.toFixed(4)}) for ${u.totalTokens} tokens. Estimate only.`,
        ));
      }
      return { consumed: true };
    }

    case "telemetry": {
      const t = session.telemetry;
      const u = session.tokenUsage;
      const est = estimateCost(u, { provider: config.provider, model: config.model, pricing: config.telemetry.pricing });
      console.log(chalk.dim(
        `Telemetry — tokens ${u.totalTokens} · ` +
          `model calls ${t?.modelCalls ?? 0} · tool calls ${t?.toolCalls ?? 0} · check runs ${t?.checkRuns ?? 0} · ` +
          `warnings ${t?.warnings.length ?? 0}${est.pricingKnown ? ` · est ~$${est.totalUsd.toFixed(4)}` : ""}`,
      ));
      return { consumed: true };
    }

    case "context": {
      const used = estimateMessages(session.messages);
      const budget = config.contextBudgetTokens;
      const pct = Math.round((used / budget) * 100);
      console.log(chalk.dim(`~${used} / ${budget} tokens (${pct}%), compacts at ${Math.round(config.compactAt * 100)}%`));
      return { consumed: true };
    }

    case "compact": {
      const res = compactIfNeeded(session.messages, {
        budgetTokens: config.contextBudgetTokens,
        compactAt: config.compactAt,
        todos: session.todos,
        force: true,
      });
      console.log(
        res.compacted
          ? chalk.dim(`Compacted ~${res.before} → ~${res.after} tokens.`)
          : chalk.dim("Nothing to compact yet."),
      );
      if (res.compacted) await save();
      return { consumed: true };
    }

    case "plan": {
      if (!arg) {
        console.log(chalk.dim("usage: /plan <what to plan> — produces a plan only, runs no tools."));
        return { consumed: true };
      }
      const planningModel = config.reasonerModel || "deepseek-reasoner";
      // Planning context: system prompt + any compaction summaries + the request.
      // Tool-call history is intentionally omitted (reasoner runs plan-only, no tools).
      const planMessages: AgentMessage[] = [
        session.messages[0]!,
        ...session.messages.filter((m) => m.role === "system" && m.content.startsWith("[compacted-summary]")),
        { role: "user", content: `Produce a concrete, step-by-step plan (do NOT execute anything): ${arg}` },
      ];
      console.log(chalk.dim(`Planning with ${planningModel}…`));
      const res = await session.provider.chat({ messages: planMessages, tools: [], model: planningModel });
      console.log("\n" + res.text + "\n");
      // Record the plan in real history so it can guide later implementation.
      session.messages.push({ role: "user", content: `/plan ${arg}` });
      session.messages.push({ role: "assistant", content: res.text });
      await save();
      return { consumed: true };
    }

    case "checkpoint": {
      if (config.checkpoints === "off" || !session.recorder) {
        console.log(chalk.dim("Checkpoints are off. Enable with DEEPCODER_CHECKPOINTS=manual (or auto)."));
        return { consumed: true };
      }
      if (session.recorder.size === 0) {
        console.log(chalk.dim("Nothing to checkpoint — the agent hasn't changed any files yet."));
        return { consumed: true };
      }
      const id = await session.recorder.finalize(arg || undefined);
      console.log(id ? chalk.dim(`Checkpoint ${id} saved. /rollback ${id} to undo.`) : chalk.dim("Nothing to checkpoint."));
      return { consumed: true };
    }

    case "checkpoints": {
      const list = await listCheckpoints(config.workspaceRoot);
      if (list.length === 0) console.log(chalk.dim("No checkpoints."));
      else for (const c of list) console.log(`${c.id}  ${chalk.dim(`${c.files.length} file(s) · ${c.createdAt}${c.label ? ` · ${c.label}` : ""}`)}`);
      return { consumed: true };
    }

    case "rollback": {
      const parts = arg.split(/\s+/).filter(Boolean);
      const force = parts.includes("--force");
      const id = parts.find((p) => p !== "--force");
      if (!id) {
        console.log(chalk.dim("usage: /rollback <id> [--force]  (see /checkpoints)"));
        return { consumed: true };
      }
      // FYI only — read-only, never commits.
      const git = new Git(config.workspaceRoot);
      if (await git.isRepo()) console.log(chalk.dim(`git: ${await git.dirtySummary()}`));
      try {
        const res = await rollback(config.workspaceRoot, id, { force });
        if (res.restored.length) console.log(chalk.green(`restored: ${res.restored.join(", ")}`));
        if (res.deleted.length) console.log(chalk.green(`deleted (agent-created): ${res.deleted.join(", ")}`));
        if (res.skipped.length) console.log(chalk.dim(`skipped: ${res.skipped.join(", ")}`));
        if (res.conflicts.length) {
          console.log(chalk.yellow(`conflicts (changed since checkpoint, NOT touched): ${res.conflicts.join(", ")}`));
          console.log(chalk.dim("Re-run with --force to overwrite the conflicting files."));
        }
        if (!res.restored.length && !res.deleted.length && !res.conflicts.length) {
          console.log(chalk.dim("Nothing to roll back (files already match the checkpoint)."));
        }
      } catch (err) {
        console.log(chalk.red(`rollback failed: ${(err as Error).message}`));
      }
      return { consumed: true };
    }

    case "ps":
      runPsSlash(activityRegistry, arg);
      return { consumed: true };

    case "stop":
      runStopSlash(activityRegistry, arg);
      return { consumed: true };

    case "review": {
      if (!arg) {
        console.log(chalk.dim("usage: /review <scope>  — run a read-only reviewer subagent over the given files/topic"));
        return { consumed: true };
      }
      await runSubagentCommand(session, save, reviewer, `Review this scope for bugs, regressions, and missing tests: ${arg}`);
      return { consumed: true };
    }

    case "research": {
      if (!arg) {
        console.log(chalk.dim("usage: /research <question>  — run a read-only researcher subagent to explain the codebase"));
        return { consumed: true };
      }
      await runSubagentCommand(
        session,
        save,
        researcher,
        `Answer this question about the codebase using only read-only inspection; cite file:line evidence where possible: ${arg}`,
      );
      return { consumed: true };
    }

    case "context-plan": {
      if (!arg) {
        console.log(chalk.dim("usage: /context-plan <task>  — build a deterministic context plan from the repo index"));
        return { consumed: true };
      }
      const root = session.executionRoot ?? session.config.workspaceRoot;
      console.log(chalk.dim("Loading repo index…"));
      const saved = await loadIndex(root);
      const index = saved?.index ?? await buildRepoIndex(root);
      const checkNames = Object.keys(session.config.checks);
      const plan = buildDeterministicPlan({
        task: arg,
        index,
        checkNames,
        changedFiles: [...session.writeTracker].map((p) => {
          // Convert absolute paths to workspace-relative
          if (p.startsWith(root)) return p.slice(root.length + 1);
          return p;
        }),
      });
      console.log(chalk.bold("\nContext Plan:"));
      console.log(chalk.dim(`Task summary: ${plan.taskSummary}`));
      if (plan.likelyAreas.length) console.log(chalk.dim(`Likely areas: ${plan.likelyAreas.join(", ")}`));
      if (plan.initialQueries.length) console.log(chalk.dim(`Initial queries: ${plan.initialQueries.join(", ")}`));
      if (plan.mustRead.length) console.log(chalk.dim(`Must-read files: ${plan.mustRead.join(", ")}`));
      if (plan.likelySymbols.length) console.log(chalk.dim(`Likely symbols: ${plan.likelySymbols.join(", ")}`));
      if (plan.likelyChecks.length) console.log(chalk.dim(`Likely checks: ${plan.likelyChecks.join(", ")}`));
      if (plan.riskNotes.length) {
        console.log(chalk.yellow("Risks:"));
        for (const r of plan.riskNotes) console.log(chalk.yellow(`  - ${r}`));
      }
      if (plan.stopConditions.length) {
        console.log(chalk.dim("Stop conditions:"));
        for (const s of plan.stopConditions) console.log(chalk.dim(`  - ${s}`));
      }
      return { consumed: true };
    }

    case "explore": {
      if (!arg) {
        console.log(chalk.dim("usage: /explore <question>  — run a read-only explorer subagent and produce a cited brief"));
        return { consumed: true };
      }
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      console.log(chalk.dim("Running explorer subagent (read-only)…"));
      try {
        const { brief, trace } = await runExplorer(arg, {
          workspaceRoot: session.config.workspaceRoot,
          provider: session.provider,
          parentModel: session.config.model,
          subagentModel: session.config.subagentModel,
          contextBudgetTokens: session.config.contextBudgetTokens,
          compactAt: session.config.compactAt,
          signal: controller.signal,
        });
        console.log("\n" + chalk.bold("Explorer brief:"));
        console.log(renderExplorerBrief(brief));
        console.log(chalk.dim(`  · ${trace.toolsCalled.length} tool calls · ${trace.turns} turns · ${trace.model}`));
        console.log(chalk.dim("  (advisory — verify by reading files before editing)"));
        // Save to quarantined session metadata — NEVER into model-visible history.
        session.briefs.push({ createdAt: new Date().toISOString(), brief, trace });
        await save();
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
      return { consumed: true };
    }

    case "triage": {
      const parsed = parseTriageArgs(arg);
      if (!parsed.scope && !parsed.file && !parsed.failure && !parsed.run) {
        console.log(
          chalk.dim(
            "usage: /triage <failure>  |  /triage --file <path>  |  /triage --run <check-run-id>  |  /triage --scope <scope> <failure>",
          ),
        );
        return { consumed: true };
      }

      const taskParts = [
        "Triage this failure using only read-only inspection. Identify what failed, the most likely cause " +
          "(ranked hypotheses with file:line evidence), the relevant files/functions, and what to inspect or " +
          "re-run BY HAND next. You did not run anything — do not claim any test was run or passed.",
      ];
      if (parsed.scope) taskParts.push(`\nScope to focus on: ${parsed.scope}`);
      if (parsed.failure) taskParts.push(`\nReported failure:\n${parsed.failure}`);
      if (parsed.file) {
        const log = readLogInput(session.config.workspaceRoot, parsed.file);
        if ("error" in log) {
          console.log(chalk.red(log.error));
          return { consumed: true }; // no provider call
        }
        taskParts.push(
          `\nFailure log from ${parsed.file}${log.truncated ? " (truncated)" : ""}:\n\`\`\`\n${log.text}\n\`\`\``,
        );
      }
      if (parsed.run) {
        // Triage a saved/quarantined check run by id (closes the check→triage loop).
        let loaded: { run: { name: string; exitCode: number | null; command: string }; log: string };
        try {
          loaded = await loadCheckRun(session.config.workspaceRoot, parsed.run);
        } catch {
          const ids = (await listCheckRuns(session.config.workspaceRoot)).slice(0, 8).map((r) => r.id);
          console.log(chalk.red(`No saved check run "${parsed.run}".`));
          if (ids.length) console.log(chalk.dim(`recent runs: ${ids.join(", ")}`));
          return { consumed: true }; // no provider call
        }
        const r = loaded.run;
        taskParts.push(
          `\nFailure from check "${r.name}" (command: ${r.command}; exit ${r.exitCode ?? "?"}), run ${parsed.run}:\n` +
            `\`\`\`\n${loaded.log}\n\`\`\``,
        );
      }

      await runSubagentCommand(session, save, testTriage, taskParts.join("\n"));
      return { consumed: true };
    }

    case "checks": {
      const names = Object.keys(config.checks);
      if (names.length === 0) {
        console.log(
          chalk.dim(
            'No checks configured. Add to .deepcoder/config.json, e.g.:\n  { "checks": { "unit": { "command": "npm run test:unit" } } }',
          ),
        );
        return { consumed: true };
      }
      for (const n of names.sort()) {
        const c = config.checks[n]!;
        const gate = classifyCommand(c.command) === "deny" ? chalk.red(" [blocked by policy]") : "";
        console.log(`${n.padEnd(16)} ${chalk.dim(c.command)}${gate}`);
      }
      return { consumed: true };
    }

    case "check": {
      const name = arg.trim();
      if (!name) {
        console.log(chalk.dim("usage: /check <name>   (see /checks)"));
        return { consumed: true };
      }
      const check = config.checks[name];
      if (!check) {
        console.log(chalk.red(`Unknown check "${name}". See /checks.`));
        return { consumed: true };
      }
      if (classifyCommand(check.command) === "deny") {
        console.log(chalk.red(`Check "${name}" is blocked by the permission policy: ${check.command}`));
        return { consumed: true };
      }
      const timeoutMs = check.timeoutMs ?? 120000;
      const ok = await confirm(`Run check "${name}": ${chalk.bold(check.command)} (timeout ${Math.round(timeoutMs / 1000)}s)?`);
      if (!ok) {
        console.log(chalk.dim("Cancelled."));
        return { consumed: true };
      }

      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        const run = await runCheck(name, check, {
          workspaceRoot: session.executionRoot ?? config.workspaceRoot, // isolated worktree when isolation is active
          signal: controller.signal,
          onData: (chunk) => stdout.write(chunk), // already redacted by the runner
          sandbox: config.sandbox,
          dependencyHealing: config.dependencyHealing,
        });
        const status = run.timedOut
          ? chalk.red("timed out")
          : run.exitCode === 0
            ? chalk.green("passed (exit 0)")
            : chalk.red(`failed (exit ${run.exitCode ?? "?"}${run.signal ? `, ${run.signal}` : ""})`);
        console.log(
          `\n${status} · ${Math.round(run.durationMs)}ms${run.truncated ? " · output truncated" : ""} · run ${run.id}`,
        );
        console.log(chalk.dim(`saved to ${run.logPath} (quarantined) · triage with /triage --run ${run.id}`));
      } catch (err) {
        if (err instanceof CheckRefusedError) console.log(chalk.red(err.message));
        else console.log(chalk.red(`check failed to start: ${(err as Error).message}`));
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
      return { consumed: true };
    }

    case "sandbox": {
      const sb = config.sandbox;
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      const MODES: SandboxMode[] = ["off", "fast", "local", "bubblewrap"];
      if (sub && MODES.includes(sub as SandboxMode)) {
        sb.mode = sub as SandboxMode; // shared with session.config.sandbox → applies next run
        console.log(chalk.dim(`sandbox mode → ${sb.mode}`));
      } else if (sub === "network" && (parts[1] === "on" || parts[1] === "off")) {
        sb.network = parts[1];
        console.log(chalk.dim(`sandbox network → ${sb.network}`));
      } else if (sub) {
        console.log(chalk.dim("usage: /sandbox [off|fast|local|bubblewrap | network on|off]"));
      }
      let backend: string;
      let note = "";
      try {
        backend = resolveBackend(sb.mode, sb.fallback);
        if ((sb.mode === "fast" || sb.mode === "bubblewrap") && backend === "local") {
          note = chalk.yellow(" (bwrap unavailable — running locally)");
        }
      } catch (e) {
        backend = (e as Error).message;
        note = chalk.red(" (fail-closed — will refuse to run)");
      }
      console.log(
        `mode: ${sb.mode}\n` +
          `backend: ${backend}${note}\n` +
          `network: ${sb.network}\n` +
          `fallback: ${sb.fallback}\n` +
          `workspaceWrite: ${sb.workspaceWrite}\n` +
          `workspace: ${config.workspaceRoot}`,
      );
      return { consumed: true };
    }

    case "index": {
      // 8C: ignore-aware scan + classification (+ optional symbol definitions).
      const root = session.executionRoot ?? config.workspaceRoot;
      const [sub, ...subRest] = arg.trim().split(/\s+/);
      const query = subRest.join(" ").trim();
      if (sub === "status") {
        const saved = await loadIndex(root);
        if (!saved) {
          console.log(chalk.dim("no saved index — run /index rebuild to build and persist one."));
        } else {
          const c = saved.index.counts;
          console.log(
            `saved index — built ${saved.createdAt}\n` +
              `  ${saved.index.files.length} files · code ${c.code} · test ${c.test} · config ${c.config} · docs ${c.docs} · generated ${c.generated} · other ${c.other}\n` +
              `  ${saved.index.symbols.length} symbols · ${saved.index.imports.length} import edges`,
          );
        }
        return { consumed: true };
      }
      if (sub === "rebuild") {
        const idx = await buildRepoIndex(root, { symbols: true, imports: true });
        await saveIndex(root, idx);
        const c = idx.counts;
        console.log(
          `rebuilt and saved index: ${idx.files.length} files (code ${c.code} · test ${c.test}), ` +
            `${idx.symbols.length} symbols, ${idx.imports.length} import edges.`,
        );
        return { consumed: true };
      }
      if (sub === "references" || sub === "refs") {
        if (!query) {
          console.log(chalk.dim("usage: /index references <symbol> [pathPrefix]"));
          return { consumed: true };
        }
        const [symbol, ...hintParts] = query.split(/\s+/);
        const idx = await buildRepoIndex(root, { symbols: true });
        const res = await findReferences(root, idx, symbol, { pathHint: hintParts.join(" ").trim() || undefined });
        console.log(`"${res.symbol}" — ${res.definitions.length} definition(s), ${res.references.length} reference(s)${res.truncated ? " (truncated)" : ""}`);
        for (const d of res.definitions) console.log(chalk.dim(`  def ${d.kind} ${d.file}:${d.line}`));
        for (const r of res.references.slice(0, 200)) console.log(chalk.dim(`  ${r.file}:${r.line}: ${r.text}`));
        return { consumed: true };
      }
      if (sub === "explain") {
        if (!query) {
          console.log(chalk.dim("usage: /index explain <workspace-relative-file>"));
          return { consumed: true };
        }
        const file = query.replace(/\\/g, "/");
        const idx = await buildRepoIndex(root, { symbols: true, imports: true });
        const entry = idx.files.find((f) => f.path === file);
        if (!entry) {
          console.log(chalk.dim(`"${file}" is not indexed (ignored, missing, or outside the workspace).`));
          return { consumed: true };
        }
        const defs = idx.symbols.filter((s) => s.file === file);
        const importsFrom = idx.imports.filter((e) => e.from === file).map((e) => e.to);
        const importers = [...(reverseGraph(idx.imports).get(file) ?? [])].sort();
        const tests = relevantTests(idx, file);
        console.log(
          `${file} — kind ${entry.kind}${entry.lang ? `, lang ${entry.lang}` : ""}\n` +
            `  defines ${defs.length} symbol(s)${defs.length ? ": " + defs.slice(0, 30).map((s) => s.name).join(", ") : ""}\n` +
            `  imports ${importsFrom.length} in-repo file(s)${importsFrom.length ? ": " + importsFrom.slice(0, 20).join(", ") : ""}\n` +
            `  imported by ${importers.length} file(s)${importers.length ? ": " + importers.slice(0, 20).join(", ") : ""}\n` +
            `  ${tests.length} likely-relevant test(s)${tests.length ? ": " + tests.slice(0, 20).join(", ") : ""}`,
        );
        return { consumed: true };
      }
      if (sub === "search") {
        if (!query) {
          console.log(chalk.dim("usage: /index search <substring>"));
          return { consumed: true };
        }
        const needle = query.toLowerCase();
        const idx = await buildRepoIndex(root);
        const hits = idx.files.filter((f) => f.path.toLowerCase().includes(needle));
        if (hits.length === 0) console.log(chalk.dim(`no indexed path matching "${query}"`));
        else {
          console.log(`${hits.length} path(s) matching "${query}"${hits.length > 200 ? " (showing 200)" : ""}:`);
          for (const f of hits.slice(0, 200)) console.log(chalk.dim(`  ${f.path} [${f.kind}]`));
        }
        return { consumed: true };
      }
      if (sub === "symbols" || sub === "sym") {
        const idx = await buildRepoIndex(root, { symbols: true });
        const hits = query
          ? idx.symbols.filter((s) => s.name === query || s.name.toLowerCase().includes(query.toLowerCase()))
          : idx.symbols;
        if (hits.length === 0) {
          console.log(chalk.dim(query ? `no symbol matching "${query}"` : "no symbols found"));
        } else {
          console.log(`${hits.length} symbol(s)${query ? ` matching "${query}"` : ""}${hits.length > 200 ? " (showing 200)" : ""}:`);
          for (const s of hits.slice(0, 200)) console.log(chalk.dim(`  ${s.kind} ${chalk.bold(s.name)} — ${s.file}:${s.line}`));
        }
        return { consumed: true };
      }
      if (sub === "tests") {
        if (!query) {
          console.log(chalk.dim("usage: /index tests <workspace-relative-file>"));
          return { consumed: true };
        }
        const idx = await buildRepoIndex(root, { imports: true });
        const hits = relevantTests(idx, query.replace(/\\/g, "/"));
        if (hits.length === 0) {
          console.log(chalk.dim(`no tests obviously relevant to "${query}"`));
        } else {
          console.log(`${hits.length} likely-relevant test(s) for ${query}:`);
          for (const f of hits.slice(0, 200)) console.log(chalk.dim(`  ${f}`));
        }
        return { consumed: true };
      }
      if (sub === "impact") {
        if (!query) {
          console.log(chalk.dim("usage: /index impact <workspace-relative-file>"));
          return { consumed: true };
        }
        const idx = await buildRepoIndex(root, { imports: true });
        const hits = impactedBy(idx, query.replace(/\\/g, "/"));
        if (hits.length === 0) {
          console.log(chalk.dim(`nothing imports "${query}" (or it isn't indexed)`));
        } else {
          console.log(`${hits.length} file(s) impacted by ${query}:`);
          for (const f of hits.slice(0, 200)) console.log(chalk.dim(`  ${f}`));
        }
        return { consumed: true };
      }
      const idx = await buildRepoIndex(root);
      const c = idx.counts;
      console.log(
        `indexed ${idx.files.length} file(s):\n` +
          `  code ${c.code} · test ${c.test} · config ${c.config} · docs ${c.docs} · generated ${c.generated} · other ${c.other}`,
      );
      if (sub === "--code" || sub === "code") {
        for (const f of idx.files.filter((f) => f.kind === "code").slice(0, 200)) {
          console.log(chalk.dim(`  ${f.path}${f.lang ? ` (${f.lang})` : ""}`));
        }
      } else {
        console.log(chalk.dim("(/index status · rebuild · code · symbols [name] · references <sym> · impact <file> · tests <file> · explain <file> · search <q>)"));
      }
      return { consumed: true };
    }

    case "memory": {
      const [sub, ...restParts] = arg.split(/\s+/);
      const subArg = restParts.join(" ").trim();
      const root = config.workspaceRoot;
      if (sub === "remember") {
        if (!subArg) {
          console.log(chalk.dim("usage: /memory remember <fact>"));
          return { consumed: true };
        }
        const res = await remember(root, subArg);
        console.log(res.ok ? chalk.dim(`remembered → ${res.file}`) : chalk.red(`not stored: ${res.reason}`));
      } else if (sub === "forget") {
        if (!subArg) {
          console.log(chalk.dim("usage: /memory forget <pattern>"));
          return { consumed: true };
        }
        const preview = await forget(root, subArg, { apply: false });
        if (preview.length === 0) {
          console.log(chalk.dim("no matching memory lines."));
          return { consumed: true };
        }
        console.log(`will remove ${preview.length} line(s):`);
        for (const m of preview) console.log(chalk.red(`  - ${m.text.trim()}`));
        if (await confirm("Remove these memory lines?")) {
          await forget(root, subArg, { apply: true });
          console.log(chalk.dim("removed."));
        } else {
          console.log(chalk.dim("kept."));
        }
      } else if (sub === "inbox") {
        const items = await loadInbox(root);
        if (items.length === 0) {
          console.log(chalk.dim("Memory inbox is empty. Auto-captured candidates appear here for review."));
          return { consumed: true };
        }
        console.log(chalk.bold(`Memory inbox (${items.length}) — review then /memory accept <n> | /memory reject <n>:`));
        items.forEach((it, i) => {
          console.log(`  ${chalk.cyan(String(i + 1))}. ${it.text} ${chalk.dim(`[${it.source} · ${it.id}]`)}`);
        });
      } else if (sub === "accept" || sub === "reject") {
        if (!subArg) {
          console.log(chalk.dim(`usage: /memory ${sub} <n|id>   (see /memory inbox)`));
          return { consumed: true };
        }
        // Resolve a 1-based index from `/memory inbox`, or treat the arg as an id.
        const items = await loadInbox(root);
        const asIndex = /^\d+$/.test(subArg) ? Number(subArg) : NaN;
        const id =
          Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= items.length
            ? items[asIndex - 1]!.id
            : subArg;
        if (sub === "accept") {
          const res = await acceptMemory(root, id);
          console.log(res.ok ? chalk.dim(`accepted → ${res.file}`) : chalk.red(`not accepted: ${res.reason}`));
        } else {
          const ok = await rejectMemory(root, id);
          console.log(ok ? chalk.dim("rejected (discarded).") : chalk.red("no such inbox item."));
        }
      } else {
        // show
        const mem = await loadStartupMemory(root);
        const topics = await listTopics(root);
        const inboxCount = (await loadInbox(root)).length;
        if (!mem && topics.length === 0 && inboxCount === 0) {
          console.log(chalk.dim("No memory yet. Add with /memory remember <fact> (writes .deepcoder/memory/MEMORY.md)."));
        } else {
          if (mem) console.log(mem.trim());
          if (topics.length) console.log(chalk.dim(`\ntopic files: ${topics.join(", ")}`));
          if (inboxCount > 0) console.log(chalk.yellow(`\n${inboxCount} candidate(s) awaiting review — /memory inbox`));
        }
      }
      return { consumed: true };
    }

    case "skills": {
      const sub = rest[0]?.trim();
      // `/skills activate <name> [args]` — explicit user activation (7C2).
      if (sub === "activate") {
        const name = rest[1]?.trim();
        if (!name) {
          console.log(chalk.dim("usage: /skills activate <name> [arguments]"));
          return { consumed: true };
        }
        const skillArgs = rest.slice(2).join(" ").trim();
        await activateSkillSlash(session, name, skillArgs);
        return { consumed: true };
      }

      // `/skills` and `/skills reload` both rediscover (discovery is on-demand).
      if (!config.skills.enabled) {
        console.log(chalk.dim("Skills are disabled (config skills.enabled=false)."));
        return { consumed: true };
      }
      const disabled = new Set(config.skills.disabled);
      const skills = (await discoverSkills(config.workspaceRoot)).filter((s) => !disabled.has(s.name));
      if (sub === "reload") console.log(chalk.dim(`Reloaded — ${skills.length} skill(s) discovered.`));
      if (skills.length === 0) {
        console.log(
          chalk.dim("No skills found. Add .deepcoder/skills/<name>/SKILL.md (YAML frontmatter with a description + a markdown body)."),
        );
        return { consumed: true };
      }
      console.log(`${skills.length} skill(s):`);
      for (const s of skills) {
        const flags = [s.disableModelInvocation ? "no-model" : null, s.userInvocable ? null : "not-user-invocable"]
          .filter(Boolean)
          .join(", ");
        console.log(`  ${chalk.bold(s.name)} ${chalk.dim(`(${s.source})`)}  ${s.description}${flags ? chalk.dim(` [${flags}]`) : ""}`);
      }
      console.log(chalk.dim("Activate with /skills activate <name> [args]  or  /$<name> [args]"));
      return { consumed: true };
    }

    case "hooks": {
      const h = config.hooks;
      const sub = arg.trim().toLowerCase();
      // Runtime enable/disable (Phase 7B). Persists for this session only.
      if (sub === "enable" || sub === "disable") {
        h.enabled = sub === "enable";
        console.log(chalk.dim(`hooks ${h.enabled ? "enabled" : "disabled"} for this session.`));
        return { consumed: true };
      }
      const order: HookEvent[] = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolFailure",
        "PostCheck",
        "SolveAttemptEnd",
        "SessionEnd",
      ];
      const lines: string[] = [`enabled: ${h?.enabled ? "yes" : "no"}`];
      let total = 0;
      for (const ev of order) {
        const list = h?.events?.[ev] ?? [];
        if (list.length === 0) continue;
        total += list.length;
        lines.push(`${ev}:`);
        for (const k of list) lines.push(`  - ${k.name}${k.matcher ? ` (matcher: ${k.matcher})` : " (all)"}`);
      }
      if (total === 0) lines.push(chalk.dim("(no hooks configured in .deepcoder/config.json)"));
      if (!h?.enabled) lines.push(chalk.dim("(disabled — /hooks enable, or set hooks.enabled in config)"));
      lines.push(chalk.dim("PreToolUse may block; all other events are advisory (warn / inject context)."));
      console.log(lines.join("\n"));
      return { consumed: true };
    }

    case "isolation": {
      const ws = session.isolation;
      const sub = arg.trim().toLowerCase();
      if (!ws) {
        console.log(
          chalk.dim(
            `workspace isolation: off (mode ${session.config.workspaceIsolation.mode})\n` +
              "start a run with --workspace-isolation patch to isolate file edits.",
          ),
        );
        return { consumed: true };
      }
      if (sub === "path") {
        console.log(ws.isolatedRoot);
      } else if (sub === "diff") {
        console.log((await ws.diff()) || chalk.dim("(no changes)"));
      } else if (sub === "apply") {
        try {
          await ws.applyPatchToRealRoot({ force: false });
          console.log(chalk.green("applied isolated changes to the real workspace."));
        } catch (err) {
          console.log(chalk.red(`apply failed: ${(err as Error).message}`));
        }
      } else if (sub === "discard") {
        await ws.cleanup();
        session.isolation = undefined;
        session.executionRoot = config.workspaceRoot;
        console.log(chalk.dim("discarded isolated workspace; edits now target the real workspace."));
      } else {
        const changed = await ws.changedFiles();
        console.log(
          `mode: ${session.config.workspaceIsolation.mode}\n` +
            `backend: ${ws.backend}\n` +
            `isolated: ${ws.isolatedRoot}\n` +
            `real: ${ws.realRoot}\n` +
            `changed files: ${changed.length}${changed.length ? `\n  ${changed.join("\n  ")}` : ""}\n` +
            chalk.dim("usage: /isolation [status|diff|apply|discard|path]"),
        );
      }
      return { consumed: true };
    }

    case "solve": {
      const [checkName, ...taskParts] = arg.split(/\s+/);
      const task = taskParts.join(" ").trim();
      if (!checkName || !task) {
        console.log(chalk.dim("usage: /solve <check-name> <task>   (edits, runs the check, retries on failure)"));
        return { consumed: true };
      }
      if (!runAgent) {
        console.log(chalk.red("Solve mode is unavailable in this context."));
        return { consumed: true };
      }
      await runSolveCommand(
        session,
        { task, checkName, maxAttempts: config.solveMaxAttempts },
        runAgent,
      );
      await save();
      return { consumed: true };
    }

    case "mcp": {
      if (!session.mcp) {
        console.log(chalk.dim("No MCP servers configured (.deepcoder/config.json → mcpServers)."));
        return { consumed: true };
      }
      if (arg === "reload") {
        console.log(chalk.dim("Reconnecting MCP servers…"));
        await session.mcp.connectAll();
        await session.mcp.registerInto(session.registry); // drops stale MCP tools first
      }
      for (const s of session.mcp.status()) {
        const state = s.connected ? chalk.green("connected") : chalk.red(s.error ?? "disconnected");
        console.log(`${s.name} [${s.mode}] ${state}`);
        for (const t of s.tools) {
          const note = s.mode === "execute" ? chalk.dim(" (execute — denied in this version)") : "";
          console.log(`  ${t}${note}`);
        }
      }
      return { consumed: true };
    }

    case "status": {
      const git = new Git(config.workspaceRoot);
      console.log((await git.isRepo()) ? await git.status() : chalk.dim("Not a git repository."));
      return { consumed: true };
    }

    case "diff": {
      const git = new Git(config.workspaceRoot);
      if (await git.isRepo()) console.log((await git.diff()) || chalk.dim("No unstaged changes."));
      else console.log(chalk.dim("Not a git repository."));
      return { consumed: true };
    }

    case "doctor": {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const isJson = parts.includes("--json");
      const sectionIdx = parts.indexOf("--section");
      const sectionFilter = sectionIdx !== -1 && parts[sectionIdx + 1] ? parts[sectionIdx + 1]!.trim().toLowerCase() : undefined;

      const report = await runDoctor({
        workspaceRoot: config.workspaceRoot,
        config,
        env: process.env,
        home: os.homedir(),
      });

      if (isJson) {
        // When --section is specified, filter findings to just that section
        let output = report;
        if (sectionFilter) {
          const filtered = report.findings.filter((f) => f.section === sectionFilter);
          output = {
            ok: filtered.every((f) => f.level !== "error"),
            summary: { ok: filtered.filter((f) => f.level === "ok").length, warn: filtered.filter((f) => f.level === "warn").length, error: filtered.filter((f) => f.level === "error").length },
            findings: filtered,
          };
        }
        console.log(JSON.stringify(output, null, 2));
      } else if (sectionFilter) {
        // Show only the filtered section + summary
        console.log(formatDoctorReport(report).split("\n").filter((l) => {
          const sectionMatch = l.match(/^(ERR|WARN|OK )\s+(\S+)/);
          if (!sectionMatch) return true; // keep summary and blank lines
          return sectionMatch[2] === sectionFilter;
        }).join("\n"));
      } else {
        console.log(formatDoctorReport(report));
      }
      return { consumed: true };
    }

    case "copy": {
      await runCopySlash(session, arg);
      return { consumed: true };
    }

    case "delegate": {
      const [sub, ...subArgs] = arg.split(/\s+/);
      const subArg = subArgs.join(" ").trim();
      // Acceptance-first global posture (default off). Defensive read: a config
      // built without a delegate section degrades to off rather than crashing.
      const acceptanceFirstEnabled = config.delegate?.acceptanceFirst?.enabled ?? false;
      const root = config.workspaceRoot;

      if (sub === "plan") {
        if (!subArg) {
          console.log(chalk.dim("usage: /delegate plan [--tdd] <task>  |  /delegate plan preflight <task>  |  /delegate plan --smart <task>"));
          return { consumed: true };
        }

        // Check for the "preflight" trigger: the first token after "plan" is "preflight".
        const [firstToken, ...restTokens] = subArgs;
        const restArg = restTokens.join(" ").trim();

        if (firstToken === "--smart") {
          if (!restArg) {
            console.log(chalk.dim("usage: /delegate plan --smart <task>  — build a model-driven decomposition plan"));
            return { consumed: true };
          }
          console.log(chalk.dim("Running model-driven decomposer…"));
          
          const { proposeDecomposition } = await import("../delegate/decompose.js");
          const { DECOMPOSE_PROMPT } = await import("../delegate/decomposePrompts.js");
          
          const deps = {
            generate: async (task: string) => {
              const prompt = `${DECOMPOSE_PROMPT}\n\nTASK:\n${task}\n\nAVAILABLE CHECKS:\n${Object.keys(config.checks).join(", ")}`;
              const route = session.modelRouter.resolve("plan");
              const provider = session.providerPool.providerFor(route);
              const res = await provider.chat({
                messages: [{ role: "user", content: prompt }],
                tools: [],
                model: route.model
              });
              return res.text;
            }
          };
          
          const plan = await proposeDecomposition(restArg, {}, deps, {
            checks: Object.keys(config.checks),
            maxSubTasks: 12
          });
          
          console.log(chalk.bold(`\nDecomposition Plan (${plan.source}):`));
          console.log(chalk.dim(`  task: ${plan.task.slice(0, 120)}${plan.task.length > 120 ? "…" : ""}`));
          console.log(chalk.dim(`  subtasks: ${plan.subtasks.length}`));
          
          for (const st of plan.subtasks) {
            const depsStr = st.dependsOn.length ? ` (after ${st.dependsOn.join(", ")})` : "";
            console.log(`    ${chalk.cyan(st.id)}: ${st.title.slice(0, 60)}${depsStr}`);
            console.log(chalk.dim(`      check: ${st.checkName} · paths: ${st.allowedPaths.join(", ")}`));
            if (st.deliverables && st.deliverables.length > 0) {
              console.log(chalk.dim(`      deliverables: ${st.deliverables.length}`));
            }
            if (st.testCommand) {
              console.log(chalk.dim(`      testCommand: ${st.testCommand}`));
            }
          }
          
          if (plan.warnings && plan.warnings.length > 0) {
            console.log(chalk.yellow("  warnings:"));
            for (const w of plan.warnings) console.log(chalk.yellow(`    - ${w}`));
          }
          
          return { consumed: true };
        }

        if (firstToken === "preflight") {
          if (!restArg) {
            console.log(chalk.dim("usage: /delegate plan preflight <task>  — build a context-aware delegation plan"));
            return { consumed: true };
          }
          console.log(chalk.dim("Running context-aware planner (explorer subagent)…"));
          const plan = await buildContextAwarePlan(restArg, {
            checkNames: Object.keys(config.checks),
          });
          await savePlan(root, plan);
          console.log(chalk.bold("\nDelegation Plan (context-aware):"));
          console.log(chalk.dim(`  id: ${plan.id}`));
          console.log(chalk.dim(`  task: ${plan.task.slice(0, 120)}${plan.task.length > 120 ? "…" : ""}`));
          console.log(chalk.dim(`  workers: ${plan.workers.length}`));
          if (plan.contextBrief) {
            console.log(chalk.green(`  context brief: attached (${plan.contextBrief.length} bytes)`));
          } else {
            console.log(chalk.yellow("  context brief: none (fallback to deterministic plan)"));
          }
          for (const w of plan.workers) {
            const deps = w.dependsOn.length ? ` (after ${w.dependsOn.join(", ")})` : "";
            console.log(`    ${chalk.cyan(w.id)}: ${w.title.slice(0, 60)}${deps}`);
            console.log(chalk.dim(`      check: ${w.checkName} · paths: ${w.allowedPaths.join(", ")}`));
          }
          if (plan.dependencies.length) {
            console.log(chalk.dim("  dependencies:"));
            for (const d of plan.dependencies) {
              console.log(chalk.dim(`    ${d.before} → ${d.after} (${d.reason.slice(0, 60)})`));
            }
          }
          if (plan.riskNotes.length) {
            console.log(chalk.yellow("  risks:"));
            for (const r of plan.riskNotes) console.log(chalk.yellow(`    - ${r}`));
          }
          console.log(chalk.dim(`\nSaved to .deepcoder/delegations/${plan.id}/plan.json`));
          return { consumed: true };
        }

        // Plain deterministic plan (existing behavior).
        const isTdd = subArgs.includes("--tdd");
        // Acceptance-first: global config flag OR a per-plan `--strict` override.
        const acceptanceFirst = acceptanceFirstEnabled || subArgs.includes("--strict");
        const taskArg = subArgs.filter((x) => x !== "--tdd" && x !== "--strict").join(" ").trim();

        if (!taskArg) {
          console.log(chalk.dim("usage: /delegate plan [--tdd] [--strict] <task>"));
          return { consumed: true };
        }

        const plan = buildPlan(taskArg, { tdd: isTdd, acceptanceFirst, checkNames: Object.keys(config.checks) });
        await savePlan(root, plan);
        console.log(chalk.bold("\nDelegation Plan:"));
        console.log(chalk.dim(`  id: ${plan.id}`));
        console.log(chalk.dim(`  task: ${plan.task.slice(0, 120)}${plan.task.length > 120 ? "…" : ""}`));
        console.log(chalk.dim(`  workers: ${plan.workers.length}`));
        for (const w of plan.workers) {
          const deps = w.dependsOn.length ? ` (after ${w.dependsOn.join(", ")})` : "";
          console.log(`    ${chalk.cyan(w.id)}: ${w.title.slice(0, 60)}${deps}`);
          console.log(chalk.dim(`      check: ${w.checkName} · paths: ${w.allowedPaths.join(", ")}`));
        }
        if (plan.dependencies.length) {
          console.log(chalk.dim("  dependencies:"));
          for (const d of plan.dependencies) {
            console.log(chalk.dim(`    ${d.before} → ${d.after} (${d.reason.slice(0, 60)})`));
          }
        }
        if (plan.riskNotes.length) {
          console.log(chalk.yellow("  risks:"));
          for (const r of plan.riskNotes) console.log(chalk.yellow(`    - ${r}`));
        }
        console.log(chalk.dim(`\nSaved to .deepcoder/delegations/${plan.id}/plan.json`));
        return { consumed: true };
      }

      if (sub === "status") {
        if (!subArg) {
          console.log(chalk.dim("usage: /delegate status <plan-id>  — show worker status table"));
          return { consumed: true };
        }
        const plan = await loadPlan(root, subArg);
        if (!plan) {
          console.log(chalk.red(`Plan "${subArg}" not found or corrupt.`));
          return { consumed: true };
        }
        console.log(chalk.bold(`\nPlan: ${plan.id}`));
        console.log(chalk.dim(`  task: ${plan.task.slice(0, 80)}${plan.task.length > 80 ? "…" : ""}`));
        console.log(chalk.dim(`  status: ${plan.status}`));
        console.log("");
        // Bounded table: cap rows at 20, truncate long values.
        const rows = plan.workers.slice(0, 20);
        for (const w of rows) {
          const color = w.status === "passed" || w.status === "applied" ? chalk.green
            : w.status === "failed" || w.status === "conflict" ? chalk.red
            : w.status === "running" ? chalk.yellow
            : chalk.dim;
          const check = w.checkName.length > 20 ? w.checkName.slice(0, 17) + "…" : w.checkName;
          const title = w.title.length > 40 ? w.title.slice(0, 37) + "…" : w.title;
          console.log(`  ${chalk.cyan(w.id.padEnd(12))} ${color(w.status.padEnd(12))} ${check.padEnd(22)} ${title}`);
        }
        if (plan.workers.length > 20) {
          console.log(chalk.dim(`  … and ${plan.workers.length - 20} more worker(s)`));
        }

        const changedByWorker: Record<string, string[]> = {};
        for (const w of plan.workers) {
          const changed = await readWorkerRunChangedFiles(root, subArg, w.id);
          if (changed && changed.length > 0) changedByWorker[w.id] = changed;
        }
        const conflicts = detectFileConflicts(changedByWorker);
        if (conflicts.length > 0) {
          console.log("");
          console.log(chalk.yellow("conflicts:"));
          for (const c of conflicts) {
            const shared = c.paths.slice(0, 20).join(", ");
            const more = c.paths.length > 20 ? ` … (+${c.paths.length - 20})` : "";
            console.log(chalk.yellow(`  - ${c.a} ↔ ${c.b}: ${shared}${more}`));
          }
        }
        return { consumed: true };
      }

      if (sub === "tdd") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate tdd <plan-id> <worker-id>  — show TDD status for a worker"));
          return { consumed: true };
        }
        const plan = await loadPlan(root, planId);
        if (!plan) {
          console.log(chalk.red(`Plan "${planId}" not found or corrupt.`));
          return { consumed: true };
        }
        const worker = plan.workers.find((w) => w.id === workerId);
        if (!worker) {
          console.log(chalk.red(`Worker "${workerId}" not found in plan "${planId}".`));
          return { consumed: true };
        }

        const tddRecord = await readTddRecord(root, planId, workerId);
        if (!tddRecord) {
          console.log(chalk.yellow(`No TDD record found for worker "${workerId}" in plan "${planId}".`));
          return { consumed: true };
        }

        console.log(chalk.bold(`\nTDD ${workerId}`));
        console.log(`  repro: ${tddRecord.reproPaths.join(", ") || "none"}`);

        const redStatus = tddRecord.status === "red_confirmed" || tddRecord.status === "green_failed" || tddRecord.status === "green_confirmed"
          ? chalk.green("confirmed")
          : tddRecord.status === "red_failed"
          ? chalk.red("failed")
          : chalk.dim("not_started");
        const redRun = tddRecord.redRunId ? ` · run ${tddRecord.redRunId}` : "";
        const redOutcome = tddRecord.status === "red_confirmed" || tddRecord.status === "green_failed" || tddRecord.status === "green_confirmed"
          ? " · failed as expected"
          : tddRecord.status === "red_failed"
          ? " · passed on baseline (unexpected)"
          : "";
        console.log(`  red:   ${redStatus}${redRun}${redOutcome}`);

        const greenStatus = tddRecord.status === "green_confirmed"
          ? chalk.green("confirmed")
          : tddRecord.status === "green_failed"
          ? chalk.red("failed")
          : chalk.dim("not_started");
        const greenRun = tddRecord.greenRunId ? ` · run ${tddRecord.greenRunId}` : "";
        const greenOutcome = tddRecord.status === "green_confirmed"
          ? " · passed"
          : tddRecord.status === "green_failed"
          ? " · failed"
          : "";
        console.log(`  green: ${greenStatus}${greenRun}${greenOutcome}`);

        const runDir = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId);
        const getPatchSizeStr = async (filename: string): Promise<string | null> => {
          try {
            const stat = await fs.stat(path.join(runDir, filename));
            const kb = (stat.size / 1024).toFixed(1);
            return `${filename} ${kb}KB`;
          } catch {
            return null;
          }
        };

        const reproPatchStr = await getPatchSizeStr("repro.patch");
        const fixPatchStr = await getPatchSizeStr("fix.patch");
        const patchesList = [reproPatchStr, fixPatchStr].filter(Boolean).join(" · ");
        if (patchesList) {
          console.log(`  patches: ${patchesList}`);
        }
        if (tddRecord.warnings.length) {
          console.log(chalk.yellow("  warnings:"));
          for (const w of tddRecord.warnings) {
            console.log(chalk.yellow(`    - ${w}`));
          }
        }
        return { consumed: true };
      }

      if (sub === "review") {
        if (!subArg) {
          console.log(chalk.dim("usage: /delegate review <plan-id>  — show full plan for human review"));
          return { consumed: true };
        }
        const plan = await loadPlan(root, subArg);
        if (!plan) {
          console.log(chalk.red(`Plan "${subArg}" not found or corrupt.`));
          return { consumed: true };
        }
        // Bounded rendering: cap total output.
        const MAX_WORKERS = 20;
        const MAX_DEPS = 20;
        const MAX_RISKS = 20;
        const MAX_STR_LEN = 200;

        console.log(chalk.bold("\n=== Delegation Plan Review ==="));
        console.log(chalk.dim(`id:        ${plan.id}`));
        console.log(chalk.dim(`created:   ${plan.createdAt}`));
        console.log(chalk.dim(`status:    ${plan.status}`));
        console.log(chalk.dim(`task:      ${plan.task.slice(0, MAX_STR_LEN)}${plan.task.length > MAX_STR_LEN ? "…" : ""}`));
        console.log("");

        console.log(chalk.bold("Workers:"));
        for (const w of plan.workers.slice(0, MAX_WORKERS)) {
          console.log(`  ${chalk.cyan(w.id)}`);
          console.log(chalk.dim(`    title:       ${w.title.slice(0, MAX_STR_LEN)}`));
          console.log(chalk.dim(`    check:       ${w.checkName}`));
          console.log(chalk.dim(`    maxAttempts: ${w.maxAttempts}`));
          console.log(chalk.dim(`    status:      ${w.status}`));
          if (w.allowedPaths.length) console.log(chalk.dim(`    allowed:     ${w.allowedPaths.join(", ")}`));
          if (w.forbiddenPaths.length) console.log(chalk.dim(`    forbidden:   ${w.forbiddenPaths.join(", ")}`));
          if (w.dependsOn.length) console.log(chalk.dim(`    dependsOn:   ${w.dependsOn.join(", ")}`));
          if (w.expectedOutputs.length) console.log(chalk.dim(`    outputs:     ${w.expectedOutputs.join(", ")}`));
          console.log("");
        }
        if (plan.workers.length > MAX_WORKERS) {
          console.log(chalk.dim(`  … and ${plan.workers.length - MAX_WORKERS} more worker(s)\n`));
        }

        if (plan.dependencies.length) {
          console.log(chalk.bold("Dependencies:"));
          for (const d of plan.dependencies.slice(0, MAX_DEPS)) {
            console.log(`  ${d.before} → ${d.after}  ${chalk.dim(d.reason.slice(0, MAX_STR_LEN))}`);
          }
          if (plan.dependencies.length > MAX_DEPS) {
            console.log(chalk.dim(`  … and ${plan.dependencies.length - MAX_DEPS} more`));
          }
          console.log("");
        }

        if (plan.globalChecks.length) {
          console.log(chalk.bold("Global checks:"));
          for (const c of plan.globalChecks) console.log(`  ${c}`);
          console.log("");
        }

        if (plan.riskNotes.length) {
          console.log(chalk.yellow("Risk notes:"));
          for (const r of plan.riskNotes.slice(0, MAX_RISKS)) console.log(chalk.yellow(`  - ${r}`));
          if (plan.riskNotes.length > MAX_RISKS) {
            console.log(chalk.dim(`  … and ${plan.riskNotes.length - MAX_RISKS} more`));
          }
          console.log("");
        }
        console.log(chalk.green("live repo was not modified by this run — it changes only through /delegate apply."));
        return { consumed: true };
      }

      if (sub === "run") {
        // Parse flags out of the args so positionals (plan-id, worker-id) are clean.
        // `--parallel` and `--max-concurrency <n>` only apply to the run-all form.
        // Acceptance-first selects the TDD lifecycle without an explicit --tdd:
        // either the global config flag, or the plan was built strict (workers
        // already carry tdd.required — checked after the plan loads below).
        let isTddRun = subArgs.includes("--tdd") || acceptanceFirstEnabled;
        const parallel = subArgs.includes("--parallel");
        const mcIdx = subArgs.indexOf("--max-concurrency");
        const rawMc = mcIdx !== -1 ? Number(subArgs[mcIdx + 1]) : NaN;
        const maxConcurrency = Number.isFinite(rawMc) ? Math.min(8, Math.max(1, Math.trunc(rawMc))) : 2;
        // Phase 9M — `--manifest <file.json>` attaches a deliverable coverage
        // manifest to the target worker(s): { deliverables:[{id,acceptance}], testCommand, allowedTestPaths? }.
        const manIdx = subArgs.indexOf("--manifest");
        const manifestPath = manIdx !== -1 ? subArgs[manIdx + 1] : undefined;
        const positional = subArgs.filter(
          (a, i) =>
            a !== "--tdd" &&
            !a.startsWith("--") &&
            !(mcIdx !== -1 && i === mcIdx + 1) &&
            !(manIdx !== -1 && i === manIdx + 1),
        );
        const planId = positional[0];
        const workerId = positional[1];
        if (!planId) {
          console.log(chalk.dim("usage: /delegate run [--tdd] <plan-id> [worker-id]  — run one worker or all runnable workers sequentially (no auto-apply)"));
          return { consumed: true };
        }
        // Nested-delegation guard: a process that is itself a delegated worker
        // must not spawn further workers. Fail closed.
        const depth = delegateDepthFromEnv(process.env);
        if (depth > 0) {
          console.log(chalk.red(`Refusing nested delegation: this process is itself a delegated worker (depth ${depth}).`));
          return { consumed: true };
        }
        // Spawning a live worker is gated to interactive sessions.
        if (!process.stdin.isTTY) {
          console.log(chalk.red("Refusing to spawn a worker in a non-interactive session — run /delegate run from an interactive terminal."));
          return { consumed: true };
        }
        const plan = await loadPlan(root, planId);
        if (!plan) {
          console.log(chalk.red(`Plan "${planId}" not found or corrupt.`));
          return { consumed: true };
        }
        // A plan built under acceptance-first (e.g. /delegate plan --strict) carries
        // tdd.required on its workers — honor it even if the global flag is off.
        isTddRun = isTddRun || plan.workers.some((w) => w.tdd?.required);
        const requireValidatedTest = acceptanceFirstEnabled || plan.workers.some((w) => w.tdd?.required);

        if (workerId) {
          const worker = plan.workers.find((w) => w.id === workerId);
          if (!worker) {
            console.log(chalk.red(`Worker "${workerId}" not found in plan "${planId}".`));
            return { consumed: true };
          }
          if (worker.status !== "planned" && worker.status !== "failed") {
            console.log(chalk.red(`Worker "${workerId}" is not runnable (status: ${worker.status}).`));
            return { consumed: true };
          }
          // Phase 9M — apply a deliverable coverage manifest (forces the worker
          // to author a red test per deliverable before it may implement).
          if (manifestPath) {
            if (!isTddRun) {
              console.log(chalk.red("--manifest requires --tdd (manifest coverage is a TDD-mode gate)."));
              return { consumed: true };
            }
            const loaded = await loadCoverageManifest(root, manifestPath);
            if (!loaded.ok) {
              console.log(chalk.red(`Invalid --manifest: ${loaded.error}`));
              return { consumed: true };
            }
            worker.tdd = {
              ...(worker.tdd ?? { required: true }),
              required: true,
              deliverables: loaded.deliverables,
              testCommand: loaded.testCommand,
              allowedTestPaths: loaded.allowedTestPaths ?? worker.tdd?.allowedTestPaths ?? ["test/", "tests/"],
            };
            console.log(chalk.dim(`  manifest: ${loaded.deliverables.length} deliverable(s); test command: ${loaded.testCommand}`));
          }
          const modeLabel = isTddRun ? "in TDD mode" : "in an isolated worktree";
          console.log(chalk.yellow(`\nThis spawns a live Deepcoder worker (provider: ${config.provider}) ${modeLabel}.`));
          console.log(chalk.dim(`  check:  ${worker.checkName}`));
          console.log(chalk.dim(`  prompt: ${worker.prompt.slice(0, 120)}${worker.prompt.length > 120 ? "…" : ""}`));
          console.log(chalk.dim("  The patch will NOT be applied — review it with /delegate review afterwards."));
          const confirmMsg = isTddRun ? `Run worker "${workerId}" in TDD mode?` : `Run worker "${workerId}"?`;
          if (!(await confirm(confirmMsg))) {
            console.log(chalk.dim("Cancelled."));
            return { consumed: true };
          }
          const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
          const modelOverride = resolveDelegateOverride(session);
          const ac = new AbortController();
          try {
            const { run } = isTddRun
              ? await runWorkerTdd({
                  realRoot: root,
                  plan,
                  worker,
                  signal: ac.signal,
                  mainEntry,
                  provider: config.provider,
                  modelOverride,
                  delegateDepth: depth,
                  onData: (c) => process.stdout.write(c),
                  checks: config.checks,
                })
              : await runWorker({
                  realRoot: root,
                  plan,
                  worker,
                  signal: ac.signal,
                  mainEntry,
                  provider: config.provider,
                  modelOverride,
                  delegateDepth: depth,
                  onData: (c) => process.stdout.write(c),
                });
            console.log("");
            console.log(run.checkPassed ? chalk.green(`✓ ${run.summary}`) : chalk.red(`✗ ${run.summary}`));
            if (run.changedFiles.length) {
              const shown = run.changedFiles.slice(0, 20).join(", ");
              const more = run.changedFiles.length > 20 ? ` … (+${run.changedFiles.length - 20})` : "";
              console.log(chalk.dim(`  changed: ${shown}${more}`));
            }
            if (run.patchPath) console.log(chalk.dim(`  patch:   ${run.patchPath}`));
            if (run.isolation) {
              const iso = run.isolation;
              console.log(chalk.dim(`  isolation: ${iso.backend} (${iso.cleaned ? "cleaned" : iso.kept ? `kept:${iso.isolatedRoot}` : "—"})`));
            }
            console.log(chalk.dim("  live repo was not modified by this run — apply with /delegate apply, review with /delegate review."));
            for (const w of run.warnings.slice(0, 10)) console.log(chalk.yellow(`  ! ${w}`));

            const auto = ["1", "true", "yes"].includes((process.env.DEEPCODER_DELEGATE_AUTO_APPLY ?? "").toLowerCase());
            if (run.checkPassed && auto) {
              console.log(chalk.dim("\nAttempting optional auto-apply…"));
              const autoApplyResult = await autoApplyIfEligible(root, planId, workerId, { autoApply: auto, checks: config.checks, requireValidatedTest });
              if (autoApplyResult.applied) {
                console.log(chalk.green(`✓ Auto-applied: ${autoApplyResult.reason}`));
                if (autoApplyResult.result?.globalCheckResults?.length) {
                  for (const g of autoApplyResult.result.globalCheckResults) {
                    const icon = g.passed ? chalk.green("✓") : chalk.red("✗");
                    console.log(`  ${icon} ${g.name}: ${g.summary}`);
                  }
                }
              } else {
                console.log(chalk.yellow(`✗ Auto-apply refused: ${autoApplyResult.reason}`));
              }
            }
          } catch (err) {
            console.log(chalk.red(`Worker run failed: ${(err as Error).message}`));
          }
          return { consumed: true };
        }

        const modeLabel = parallel ? `in parallel (max ${maxConcurrency})` : "sequentially";
        const tddLabel = isTddRun ? " in TDD mode" : "";
        console.log(chalk.yellow(`\nThis spawns live Deepcoder workers (provider: ${config.provider})${tddLabel} ${modeLabel} in isolated worktrees.`));
        console.log(chalk.dim("  Only runnable workers (planned/failed with all deps applied) will run."));
        console.log(chalk.dim("  No patch will be applied automatically."));
        const confirmMsg = isTddRun
          ? `Run all runnable workers in plan "${planId}" in TDD mode?`
          : `Run all runnable workers in plan "${planId}"?`;
        if (!(await confirm(confirmMsg))) {
          console.log(chalk.dim("Cancelled."));
          return { consumed: true };
        }

        const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
        const modelOverride = resolveDelegateOverride(session);
        const ac = new AbortController();
        try {
          const runOne = isTddRun
            ? async (runPlan: DelegationPlan, worker: WorkerTask): Promise<WorkerRun> => {
                const out = await runWorkerTdd({
                  realRoot: root,
                  plan: runPlan,
                  worker,
                  signal: ac.signal,
                  mainEntry,
                  provider: config.provider,
                  modelOverride,
                  delegateDepth: depth,
                  onData: (c) => process.stdout.write(c),
                  checks: config.checks,
                });
                return out.run;
              }
            : undefined;

          const driverOpts = {
            realRoot: root,
            signal: ac.signal,
            mainEntry,
            provider: config.provider,
            modelOverride,
            delegateDepth: depth,
            onData: (c: string) => process.stdout.write(c),
            runOne,
          };
          const res = parallel
            ? await runRunnableConcurrent(plan, { ...driverOpts, maxConcurrency })
            : await runRunnable(plan, driverOpts);

          console.log("");
          for (const r of res.ran) {
            const icon = r.passed ? chalk.green("✓") : chalk.red("✗");
            const status = r.passed ? chalk.green("passed") : chalk.red("failed");
            const changed = r.changedFiles.length
              ? ` · changed: ${r.changedFiles.slice(0, 20).join(", ")}${r.changedFiles.length > 20 ? ` … (+${r.changedFiles.length - 20})` : ""}`
              : "";
            console.log(`${icon} ${chalk.cyan(r.workerId)} ${status}${changed}`);
          }

          if (res.skipped.length > 0) {
            console.log("");
            console.log(chalk.dim("skipped:"));
            for (const s of res.skipped) {
              console.log(chalk.dim(`  - ${s.workerId}: ${s.reason}`));
            }
          }

          if (res.conflicts.length > 0) {
            console.log("");
            console.log(chalk.yellow("conflicts:"));
            for (const c of res.conflicts) {
              const shared = c.paths.slice(0, 20).join(", ");
              const more = c.paths.length > 20 ? ` … (+${c.paths.length - 20})` : "";
              console.log(chalk.yellow(`  - ${c.a} ↔ ${c.b}: ${shared}${more}`));
            }
          }
        } catch (err) {
          console.log(chalk.red(`Worker run failed: ${(err as Error).message}`));
        }

        return { consumed: true };
      }

      if (sub === "apply") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate apply <plan-id> <worker-id>  — apply a passed worker's patch to the real repo"));
          return { consumed: true };
        }
        // TTY gate: apply is inherently destructive.
        if (!process.stdin.isTTY) {
          console.log(chalk.red("Refusing to apply in a non-interactive session — run /delegate apply from an interactive terminal."));
          return { consumed: true };
        }
        // Acceptance-first: require a validated red→green proof when the global
        // flag is on OR the plan was built strict (worker carries tdd.required).
        const applyPlan = await loadPlan(root, planId);
        const applyWorkerTask = applyPlan?.workers.find((w) => w.id === workerId);
        const requireValidatedTest = acceptanceFirstEnabled || applyWorkerTask?.tdd?.required === true;
        const result = await applyWorker(root, planId, workerId, { checks: config.checks, requireValidatedTest });
        if (result.ok) {
          console.log(chalk.green(result.message));
          if (result.globalCheckResults?.length) {
            for (const g of result.globalCheckResults) {
              const icon = g.passed ? chalk.green("✓") : chalk.red("✗");
              console.log(`  ${icon} ${g.name}: ${g.summary}`);
            }
          }
        } else {
          console.log(chalk.red(result.message));
        }
        return { consumed: true };
      }

      if (sub === "decompose") {
        // `/delegate decompose run <task>` — model-driven decomposition, then run
        // each sub-task through verify-then-force on a cumulative base + assemble.
        // Never auto-applies: produces an assembled patch + verdict for review.
        if (subArgs[0] !== "run" || !subArgs.slice(1).join(" ").trim()) {
          console.log(chalk.dim("usage: /delegate decompose run <task>  (plan only: /delegate plan --smart <task>)"));
          return { consumed: true };
        }
        const task = subArgs.slice(1).join(" ").trim();
        const depth = delegateDepthFromEnv(process.env);
        if (depth > 0) {
          console.log(chalk.red(`Refusing nested delegation: this process is itself a delegated worker (depth ${depth}).`));
          return { consumed: true };
        }
        if (!process.stdin.isTTY) {
          console.log(chalk.red("Refusing to run decomposition in a non-interactive session — run from an interactive terminal."));
          return { consumed: true };
        }
        const { proposeDecomposition, validateDecomposition, runDecomposition } = await import("../delegate/decompose.js");
        const { DECOMPOSE_PROMPT } = await import("../delegate/decomposePrompts.js");
        const deps = {
          generate: async (t: string) => {
            const prompt = `${DECOMPOSE_PROMPT}\n\nTASK:\n${t}\n\nAVAILABLE CHECKS:\n${Object.keys(config.checks).join(", ")}`;
            const route = session.modelRouter.resolve("plan");
            const provider = session.providerPool.providerFor(route);
            const res = await provider.chat({ messages: [{ role: "user", content: prompt }], tools: [], model: route.model });
            return res.text;
          },
        };
        console.log(chalk.dim("Decomposing…"));
        const plan = await proposeDecomposition(task, {}, deps, { checks: Object.keys(config.checks), maxSubTasks: 12 });
        const validation = validateDecomposition(plan, { checks: Object.keys(config.checks), maxSubTasks: 12 });
        if (!validation.ok) {
          console.log(chalk.red("Decomposition is invalid:"));
          for (const e of validation.errors) console.log(chalk.red(`  - ${e}`));
          return { consumed: true };
        }
        console.log(chalk.bold(`\nDecomposition (${plan.source}) — ${plan.subtasks.length} sub-task(s):`));
        for (const st of plan.subtasks) {
          const after = st.dependsOn.length ? ` (after ${st.dependsOn.join(", ")})` : "";
          console.log(`  ${chalk.cyan(st.id)}: ${st.title.slice(0, 60)}${after} · check ${st.checkName}`);
        }
        console.log(chalk.yellow(`\nThis spawns live sub-task workers (provider: ${config.provider}), each verified; the result is NOT auto-applied.`));
        if (!(await confirm(`Run ${plan.subtasks.length} sub-task(s) through verify-then-force?`))) {
          console.log(chalk.dim("Cancelled."));
          return { consumed: true };
        }
        const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
        const res = await runDecomposition(plan, {
          realRoot: root, signal: new AbortController().signal,
          provider: config.provider, mainEntry, checks: config.checks, delegateDepth: depth,
        });
        console.log("");
        for (const st of res.subtasks) {
          console.log(`  ${st.accepted ? chalk.green("✓") : chalk.red("✗")} ${st.id}${st.reason ? chalk.dim(` — ${st.reason}`) : ""}`);
        }
        console.log(res.ok ? chalk.green(`\nAll sub-tasks accepted; assembly check passed.`) : chalk.red(`\nDecomposition not complete (assembly ${res.assemblyOk ? "ok" : "red"}). NOT applied.`));
        for (const w of res.warnings) console.log(chalk.yellow(`  - ${w}`));
        console.log(chalk.dim("Review the assembled patch before applying via the normal apply path."));
        return { consumed: true };
      }

      if (sub === "browse") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId) {
          console.log(chalk.dim("usage: /delegate browse <plan-id> [worker-id]"));
          return { consumed: true };
        }
        if (!workerId) {
          const overview = await getDelegationReviewOverview(root, planId, { checks: config.checks });
          if (!overview) {
            console.log(chalk.red(`Plan "${planId}" not found or corrupt.`));
            return { consumed: true };
          }
          console.log(renderReviewOverview(overview));
        } else {
          const detail = await getWorkerReviewDetail(root, planId, workerId, { checks: config.checks });
          if (!detail) {
            console.log(chalk.red(`Worker "${workerId}" not found in plan "${planId}".`));
            return { consumed: true };
          }
          console.log(renderWorkerReview(detail));
        }
        return { consumed: true };
      }

      if (sub === "review-ui") {
        const positional = subArgs.filter((a) => !a.startsWith("--"));
        const planId = positional[0];
        const workerId = positional[1];
        if (!planId) {
          console.log(chalk.dim("usage: /delegate review-ui <plan-id> [worker-id] [--no-tui]  — interactive patch review"));
          return { consumed: true };
        }
        const uiMode = resolveUiMode({
          flag: subArgs.includes("--no-tui") ? "plain" : undefined,
          env: process.env,
          isTTY: Boolean(process.stdin.isTTY),
        });
        // Non-TTY / --no-tui: static fallback (same data, no raw mode).
        if (uiMode !== "tui") {
          if (!workerId) {
            const overview = await getDelegationReviewOverview(root, planId, { checks: config.checks });
            if (!overview) { console.log(chalk.red(`Plan "${planId}" not found or corrupt.`)); return { consumed: true }; }
            console.log(renderReviewOverview(overview));
          } else {
            const detail = await getWorkerReviewDetail(root, planId, workerId, { checks: config.checks });
            if (!detail) { console.log(chalk.red(`Worker "${workerId}" not found in plan "${planId}".`)); return { consumed: true }; }
            console.log(renderWorkerReview(detail));
            console.log(renderPatchStat(detail.patchStat));
          }
          return { consumed: true };
        }
        // Interactive TUI.
        if (workerId) await runReviewUi({ root, planId, workerId, checks: config.checks });
        else await runReviewPicker({ root, planId, checks: config.checks });
        return { consumed: true };
      }

      if (sub === "diff") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        const mode = subArgs[2] || "--stat";
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate diff <plan-id> <worker-id> [--stat|--files|--full]"));
          return { consumed: true };
        }
        const detail = await getWorkerReviewDetail(root, planId, workerId, { checks: config.checks });
        if (!detail) {
          console.log(chalk.red(`Worker "${workerId}" not found in plan "${planId}".`));
          return { consumed: true };
        }
        if (mode === "--stat") {
          console.log(renderPatchStat(detail.patchStat));
        } else if (mode === "--files") {
          if (detail.changedFiles.length === 0) {
            console.log("No files changed.");
          } else {
            for (const f of detail.changedFiles) {
              const stat = detail.patchStat.find(s => s.path === f);
              console.log(`${f} (${stat?.kind || "unknown"})`);
            }
          }
        } else if (mode === "--full") {
          console.log(detail.patchPreview);
        } else {
          console.log(chalk.red(`Unknown diff mode: ${mode}`));
        }
        return { consumed: true };
      }

      if (sub === "gates") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate gates <plan-id> <worker-id>"));
          return { consumed: true };
        }
        const preview = await previewApplyGates(root, planId, workerId, { checks: config.checks, runGitCheck: true });
        console.log(renderGatePreview(preview));
        return { consumed: true };
      }

      if (sub === "log") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        const tailArg = subArgs.indexOf("--tail");
        let tailBytes = 40 * 1024;
        if (tailArg !== -1 && subArgs[tailArg + 1]) {
          tailBytes = parseInt(subArgs[tailArg + 1]!, 10) * 1024;
        }
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate log <plan-id> <worker-id> [--tail N]"));
          return { consumed: true };
        }
        const artifacts = await loadWorkerArtifacts(root, planId, workerId, { logTailBytes: tailBytes });
        if (artifacts.runLogPreview) {
          console.log(artifacts.runLogPreview);
        } else {
          console.log(chalk.dim("No run log available."));
        }
        return { consumed: true };
      }

      if (sub === "telemetry") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate telemetry <plan-id> <worker-id>"));
          return { consumed: true };
        }
        const artifacts = await loadWorkerArtifacts(root, planId, workerId);
        if (artifacts.telemetryPreview) {
          console.log(artifacts.telemetryPreview);
        } else {
          console.log(chalk.dim("No telemetry available."));
        }
        return { consumed: true };
      }

      if (sub === "discard") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId || !workerId) {
          console.log(chalk.dim("usage: /delegate discard <plan-id> <worker-id>  — discard a worker (mark as discarded, never touches the repo)"));
          return { consumed: true };
        }
        const result = await discardWorker(root, planId, workerId);
        if (result.ok) {
          console.log(chalk.green(result.message));
        } else {
          console.log(chalk.red(result.message));
        }
        return { consumed: true };
      }

      // ── Phase 9P — Delegation Autopilot ─────────────────────────────
      if (sub === "autopilot") {
        const isStatus = subArgs[0] === "status";
        const isDryRun = subArgs.includes("--dry-run");
        const acceptanceFirst = subArgs.includes("--acceptance-first");
        const mcIdx = subArgs.indexOf("--max-concurrency");
        const mwIdx = subArgs.indexOf("--max-workers");
        const mrIdx = subArgs.indexOf("--max-rounds");
        const rawMc = mcIdx !== -1 ? Number(subArgs[mcIdx + 1]) : NaN;
        const rawMw = mwIdx !== -1 ? Number(subArgs[mwIdx + 1]) : NaN;
        const rawMr = mrIdx !== -1 ? Number(subArgs[mrIdx + 1]) : NaN;

        // ── Status subcommand ────────────────────────────────────────
        if (isStatus) {
          const planId = subArgs[1];
          if (!planId) {
            console.log(chalk.dim("usage: /delegate autopilot status <plan-id>"));
            return { consumed: true };
          }
          const artifact = await readAutopilotArtifact(root, planId);
          if (!artifact) {
            console.log(chalk.red(`No autopilot artifact found for plan "${planId}".`));
            return { consumed: true };
          }
          const statusColor = artifact.finalCheck?.passed === false ? chalk.red
            : artifact.finalCheck?.passed === true ? chalk.green
            : chalk.dim;
          console.log(chalk.bold(`\nAutopilot Run: ${planId}`));
          console.log(chalk.dim(`  task:     ${artifact.task.slice(0, 120)}`));
          console.log(chalk.dim(`  started:  ${artifact.startedAt}`));
          if (artifact.finishedAt) console.log(chalk.dim(`  finished: ${artifact.finishedAt}`));
          console.log(chalk.dim(`  rounds:   ${artifact.rounds.length}`));
          console.log(chalk.dim(`  status:   ${statusColor(artifact.finalCheck ? (artifact.finalCheck.passed ? "passed" : "failed") : "incomplete")}`));
          console.log(chalk.dim(`  applied:  ${artifact.appliedWorkers.length} worker(s)`));
          console.log(chalk.dim(`  blocked:  ${artifact.blockedWorkers.length} worker(s)`));
          if (artifact.appliedWorkers.length > 0) {
            console.log(chalk.green(`  applied workers: ${artifact.appliedWorkers.join(", ")}`));
          }
          if (artifact.blockedWorkers.length > 0) {
            console.log(chalk.yellow(`  blocked workers: ${artifact.blockedWorkers.join(", ")}`));
          }
          if (artifact.finalCheck) {
            const fcIcon = artifact.finalCheck.passed ? chalk.green("✓") : chalk.red("✗");
            console.log(`${fcIcon} final check "${artifact.finalCheck.name}"${artifact.finalCheck.runId ? ` (run ${artifact.finalCheck.runId})` : ""}`);
          }
          for (const round of artifact.rounds) {
            console.log(chalk.dim(`\n  round ${round.round}:`));
            for (const r of round.ran) {
              const icon = r.passed ? chalk.green("✓") : chalk.red("✗");
              console.log(`    ${icon} ${r.workerId} (${r.changedFiles.length} files)`);
            }
            if (round.applied.length > 0) console.log(`    ${chalk.green("applied")}: ${round.applied.join(", ")}`);
            if (round.blocked.length > 0) console.log(`    ${chalk.yellow("blocked")}: ${round.blocked.join(", ")}`);
            if (round.skipped.length > 0) console.log(`    ${chalk.dim("skipped")}: ${round.skipped.join(", ")}`);
          }
          return { consumed: true };
        }

        // ── Parse task from remaining args (strip flags) ─────────────
        const flagTokens = new Set(["--dry-run", "--acceptance-first", "--max-concurrency", "--max-workers", "--max-rounds"]);
        const taskTokens = subArgs.filter((a, i) => {
          if (flagTokens.has(a)) return false;
          if (mcIdx !== -1 && i === mcIdx + 1) return false;
          if (mwIdx !== -1 && i === mwIdx + 1) return false;
          if (mrIdx !== -1 && i === mrIdx + 1) return false;
          return true;
        });
        const task = taskTokens.join(" ").trim();

        if (!task) {
          console.log(chalk.dim("usage: /delegate autopilot [--dry-run] [--acceptance-first] [--max-workers N] [--max-rounds N] [--max-concurrency N] <task>"));
          console.log(chalk.dim("       /delegate autopilot status <plan-id>"));
          return { consumed: true };
        }

        // ── Nested delegation guard ─────────────────────────────────
        const depth = delegateDepthFromEnv(process.env);
        if (depth > 0) {
          console.log(chalk.red(`Refusing nested delegation: this process is itself a delegated worker (depth ${depth}).`));
          return { consumed: true };
        }

        // ── Non-TTY guard ────────────────────────────────────────────
        if (!process.stdin.isTTY && !isDryRun) {
          console.log(chalk.red("Refusing autopilot in a non-interactive session. Use --dry-run for headless plan preview."));
          return { consumed: true };
        }

        // ── Build autopilot config ───────────────────────────────────
        const apConfig = { ...config.delegate.autopilot };
        if (isDryRun) apConfig.enabled = true; // dry-run bypasses the enabled check
        if (acceptanceFirst) apConfig.acceptanceFirst = true;
        if (Number.isFinite(rawMc)) apConfig.maxConcurrency = Math.max(1, Math.min(8, Math.trunc(rawMc)));
        if (Number.isFinite(rawMw)) apConfig.maxWorkers = Math.max(1, Math.min(20, Math.trunc(rawMw)));
        if (Number.isFinite(rawMr)) apConfig.maxRounds = Math.max(1, Math.min(10, Math.trunc(rawMr)));

        // ── Enabled check (dry-run always allowed) ──────────────────
        if (!apConfig.enabled && !isDryRun) {
          console.log(chalk.red("Autopilot is not enabled."));
          console.log(chalk.dim("Set DEEPCODER_DELEGATE_AUTOPILOT=1 or configure delegate.autopilot.enabled=true in .deepcoder/config.json."));
          console.log(chalk.dim("Use --dry-run for a headless plan preview."));
          return { consumed: true };
        }

        const modeLabel = isDryRun ? " (dry-run)" : "";
        console.log(chalk.yellow(`\nRunning delegation autopilot${modeLabel}…`));
        if (!isDryRun) {
          console.log(chalk.dim(`  rounds: ${apConfig.maxRounds} · maxWorkers: ${apConfig.maxWorkers} · maxConcurrency: ${apConfig.maxConcurrency}`));
          console.log(chalk.dim(`  acceptanceFirst: ${apConfig.acceptanceFirst} · autoApply: ${apConfig.autoApply}`));
          console.log(chalk.dim(`  task: ${task.slice(0, 120)}${task.length > 120 ? "…" : ""}`));
        }

        const controller = new AbortController();
        const onSigint = () => controller.abort();
        process.once("SIGINT", onSigint);
        try {
          const result = await runAutopilot({
            realRoot: root,
            task,
            checks: config.checks,
            config: apConfig,
            signal: controller.signal,
            confirm: async (prompt: string) => {
              // Only prompt when autoApply is true and we're interactive.
              return await confirm(prompt);
            },
            dryRun: isDryRun,
          });
          process.removeListener("SIGINT", onSigint);

          console.log("");
          if (result.status === "dry_run" && result.plan) {
            console.log(chalk.bold("Dry-Run Plan:"));
            console.log(chalk.dim(`  id: ${result.planId}`));
            console.log(chalk.dim(`  workers: ${result.plan.workers.length}`));
            for (const w of result.plan.workers) {
              const deps = w.dependsOn.length ? ` (after ${w.dependsOn.join(", ")})` : "";
              console.log(`    ${chalk.cyan(w.id)}: ${w.title.slice(0, 60)}${deps}`);
              console.log(chalk.dim(`      check: ${w.checkName} · paths: ${w.allowedPaths.join(", ")}`));
            }
            if (result.nextSteps) console.log(chalk.dim(`\n${result.nextSteps}`));
          } else if (result.status === "completed") {
            console.log(chalk.green(`✓ Autopilot completed. ${result.summary}`));
            if (result.appliedWorkers.length > 0) {
              console.log(chalk.green(`  applied: ${result.appliedWorkers.join(", ")}`));
            }
            if (result.finalCheckPassed === true) {
              console.log(chalk.green("  final check passed"));
            }
          } else if (result.status === "blocked") {
            console.log(chalk.yellow(`△ Autopilot blocked. ${result.summary}`));
            if (result.blockedWorkers.length > 0) {
              console.log(chalk.yellow(`  blocked: ${result.blockedWorkers.join(", ")}`));
            }
            if (result.nextSteps) {
              console.log(chalk.dim(`\n${result.nextSteps}`));
            }
          } else {
            console.log(chalk.red(`✗ Autopilot failed. ${result.summary}`));
          }
          console.log(chalk.dim(`Artifact: .deepcoder/delegations/${result.planId}/autopilot.json`));
        } catch (err) {
          process.removeListener("SIGINT", onSigint);
          console.log(chalk.red(`Autopilot error: ${(err as Error).message}`));
        }
        return { consumed: true };
      }

      if (sub === "propose") {
        const AVAILABLE_SCOPES: ProposalScope[] = [
          "all", "ui", "context", "delegation", "safety", "verification",
          "benchmarks", "web", "plugins", "routing", "server",
        ];
        // Parse flags
        const scopeFlag: ProposalScope = (() => {
          const si = subArgs.indexOf("--scope");
          if (si !== -1 && subArgs[si + 1]) {
            const s = subArgs[si + 1]!.toLowerCase() as ProposalScope;
            return AVAILABLE_SCOPES.includes(s) ? s : "all";
          }
          return "all";
        })();
        const limitFlag = (() => {
          const li = subArgs.indexOf("--limit");
          if (li !== -1 && subArgs[li + 1]) {
            const n = parseInt(subArgs[li + 1]!, 10);
            return Number.isFinite(n) && n > 0 ? n : 10;
          }
          return 10;
        })();
        const jsonFlag = subArgs.includes("--json");

        const root = session.executionRoot ?? config.workspaceRoot;
        const proposals = await proposeFeatures({
          workspaceRoot: root,
          scope: scopeFlag,
          limit: limitFlag,
          json: jsonFlag,
          smartSeam: null,
        });
        console.log(renderProposals(proposals, {
          json: jsonFlag,
          limit: limitFlag,
        }));
        return { consumed: true };
      }

      console.log(chalk.dim("usage: /delegate plan [preflight] <task> | run <plan-id> [worker-id] | status <plan-id> | review <plan-id> | apply <plan-id> <worker-id> | discard <plan-id> <worker-id> | autopilot [--dry-run] <task> | autopilot status <plan-id> | propose [--scope <s>] [--limit <n>] [--json]"));
      return { consumed: true };
    }

    case "tests": {
      // Phase 10H — automatic minimal test targeting.
      // Subcommands: target, plan, run-targeted
      const [sub, ...subArgs] = arg.split(/\s+/);
      const root = session.executionRoot ?? config.workspaceRoot;

      if (sub === "target") {
        // /tests target <file> [<file> ...] — show what tests would be targeted
        const files = subArgs.filter(Boolean);
        if (files.length === 0) {
          console.log(chalk.dim("usage: /tests target <file> [<file> ...]  — show targeted tests for changed files"));
          return { consumed: true };
        }
        // Auto-build the index on demand (lazy) so targeting plans are accurate
        // without a manual /index rebuild.
        const index = (await ensureIndex(root)) ?? undefined;
        const plan = buildTestTargetPlan({
          changedFiles: files,
          index,
          maxTargets: config.testTargeting.maxTargets,
          pathRules: config.testTargeting.pathRules,
          languageCommands: config.testTargeting.languageCommands,
          fallbackCheck: config.testTargeting.fallbackCheck,
        });
        console.log(chalk.bold(`Test Target Plan (confidence: ${plan.confidence})`));
        console.log(chalk.dim(`  fallbackRequired: ${plan.fallbackRequired}`));
        if (plan.fallbackCheck) console.log(chalk.dim(`  fallbackCheck: ${plan.fallbackCheck}`));
        if (plan.targetFiles.length) {
          console.log(chalk.dim(`  target files (${plan.targetFiles.length}):`));
          for (const f of plan.targetFiles) console.log(chalk.dim(`    ${f}`));
        }
        if (plan.commands.length) {
          console.log(chalk.dim("  commands:"));
          for (const c of plan.commands) {
            const icon = c.confidence === "high" ? chalk.green("✓") : c.confidence === "medium" ? chalk.yellow("~") : chalk.dim("?");
            console.log(`    ${icon} ${c.label}: ${c.command}`);
          }
        }
        if (plan.reasons.length) {
          console.log(chalk.dim("  reasons:"));
          for (const r of plan.reasons) console.log(chalk.dim(`    - ${r}`));
        }
        return { consumed: true };
      }

      if (sub === "plan") {
        // /tests plan — build a plan from the current write tracker (changed files)
        const changedFiles = [...session.writeTracker].map((p) => {
          if (p.startsWith(root)) return p.slice(root.length + 1);
          return p;
        });
        if (changedFiles.length === 0) {
          console.log(chalk.dim("No changed files tracked. Use /tests target <file> ... to specify files."));
          return { consumed: true };
        }
        // Auto-build the index on demand (lazy) so targeting plans are accurate
        // without a manual /index rebuild.
        const index = (await ensureIndex(root)) ?? undefined;
        const plan = buildTestTargetPlan({
          changedFiles,
          index,
          maxTargets: config.testTargeting.maxTargets,
          pathRules: config.testTargeting.pathRules,
          languageCommands: config.testTargeting.languageCommands,
          fallbackCheck: config.testTargeting.fallbackCheck,
        });
        console.log(chalk.bold(`Test Target Plan (confidence: ${plan.confidence})`));
        console.log(chalk.dim(`  changed files: ${changedFiles.join(", ")}`));
        console.log(chalk.dim(`  fallbackRequired: ${plan.fallbackRequired}`));
        if (plan.fallbackCheck) console.log(chalk.dim(`  fallbackCheck: ${plan.fallbackCheck}`));
        if (plan.targetFiles.length) {
          console.log(chalk.dim(`  target files (${plan.targetFiles.length}):`));
          for (const f of plan.targetFiles) console.log(chalk.dim(`    ${f}`));
        }
        if (plan.commands.length) {
          console.log(chalk.dim("  commands:"));
          for (const c of plan.commands) {
            const icon = c.confidence === "high" ? chalk.green("✓") : c.confidence === "medium" ? chalk.yellow("~") : chalk.dim("?");
            console.log(`    ${icon} ${c.label}: ${c.command}`);
          }
        }
        if (plan.reasons.length) {
          console.log(chalk.dim("  reasons:"));
          for (const r of plan.reasons) console.log(chalk.dim(`    - ${r}`));
        }
        return { consumed: true };
      }

      if (sub === "run-targeted") {
        // /tests run-targeted — build plan from write tracker and run targeted checks
        const changedFiles = [...session.writeTracker].map((p) => {
          if (p.startsWith(root)) return p.slice(root.length + 1);
          return p;
        });
        if (changedFiles.length === 0) {
          console.log(chalk.dim("No changed files tracked. Use /tests target <file> ... to specify files first."));
          return { consumed: true };
        }
        // Auto-build the index on demand (lazy) so targeting plans are accurate
        // without a manual /index rebuild.
        const index = (await ensureIndex(root)) ?? undefined;
        const plan = buildTestTargetPlan({
          changedFiles,
          index,
          maxTargets: config.testTargeting.maxTargets,
          pathRules: config.testTargeting.pathRules,
          languageCommands: config.testTargeting.languageCommands,
          fallbackCheck: config.testTargeting.fallbackCheck,
        });

        if (plan.commands.length === 0) {
          console.log(chalk.yellow("No targeted commands to run. Use fallback check instead."));
          if (plan.fallbackCheck) {
            console.log(chalk.dim(`Suggested fallback: /check ${plan.fallbackCheck}`));
          }
          return { consumed: true };
        }

        console.log(chalk.bold(`Running ${plan.commands.length} targeted command(s)…`));
        const result = await runTargetedChecks(plan, {
          workspaceRoot: root,
          signal: new AbortController().signal,
          onData: (chunk) => stdout.write(chunk),
          sandbox: config.sandbox,
          dependencyHealing: config.dependencyHealing,
          timeoutMs: 180_000,
        });

        for (const { command: cmd, run } of result.targetedRuns) {
          const status = run.timedOut
            ? chalk.red("timed out")
            : run.exitCode === 0
              ? chalk.green("passed (exit 0)")
              : chalk.red(`failed (exit ${run.exitCode ?? "?"}${run.signal ? `, ${run.signal}` : ""})`);
          console.log(`${chalk.cyan(cmd.label)} ${status} · ${Math.round(run.durationMs)}ms`);
        }

        if (result.refused.length) {
          console.log(chalk.yellow(`Refused by policy: ${result.refused.map((c) => c.label).join(", ")}`));
        }

        if (result.fallbackRequired) {
          console.log(chalk.yellow("Fallback required — some targets were not covered."));
          if (result.fallbackCheck) {
            console.log(chalk.dim(`Suggested fallback: /check ${result.fallbackCheck}`));
          }
        }
        return { consumed: true };
      }

      // Show status
      const tt = config.testTargeting;
      console.log(
        `testTargeting: ${tt.enabled ? chalk.green("enabled") : chalk.dim("disabled")}\n` +
          `  mode: ${tt.mode}\n` +
          `  fallbackCheck: ${tt.fallbackCheck}\n` +
          `  maxTargets: ${tt.maxTargets}\n` +
          `  minConfidence: ${tt.minConfidence}\n` +
          `  runFullAfterTargetedPass: ${tt.runFullAfterTargetedPass}\n` +
          `  pathRules: ${tt.pathRules.length} rule(s)\n` +
          chalk.dim("usage: /tests [target <file>... | plan | run-targeted]"),
      );
      return { consumed: true };
    }

    case "models": {
      const routes = session.modelRouter.explain();
      console.log(chalk.bold("Model Routing Table:"));
      for (const r of routes) {
        const src = r.source === "default" ? "" : chalk.dim(` [${r.source}]`);
        const temp = r.temperature !== undefined ? ` · temp ${r.temperature}` : "";
        const effort = r.reasoningEffort ? ` · effort ${r.reasoningEffort}` : "";
        console.log(`  ${chalk.cyan(r.role.padEnd(14))} ${r.provider}/${r.model}${src}${temp}${effort}`);
      }
      console.log(chalk.dim("Use /model <role> <provider>/<model> to override for this session."));
      console.log(chalk.dim("Use /effort [<role>] <low|medium|high> to set reasoning effort."));
      return { consumed: true };
    }

    case "model":
      await runModelSlash(session, arg);
      return { consumed: true };

    case "effort":
      await runEffortSlash(session, arg);
      return { consumed: true };

    case "help":
      console.log(
        [
          "/help            show this help",
          "/exit            quit",
          "/clear           clear conversation + todos (keep system prompt)",
          "/mode [m]        show or set approval mode (ask | auto | readonly)",
          "/todos           show the current todo list",
          "/instructions    show project instructions (graph: show | sources | conflicts | reload)",
          "/context         show context-token usage",
          "/compact         compact conversation history now",
          "/plan <task>     produce a plan with the reasoner model (no tools run)",
          "/mcp [reload]    list configured MCP servers and tools",
          "/review <scope>  run a read-only reviewer subagent over files/topic",
          "/research <q>    run a read-only researcher subagent to explain the codebase",
          "/triage <fail>   diagnose a failure (also: --file <log>, --run <check-run-id>, --scope <scope>)",
          "/sandbox [m]     show sandbox status; set off|fast|local|bubblewrap | network on|off",
          "/hooks [enable|disable]  show lifecycle hooks; toggle them for this session (Phase 7B)",
          "/skills          list discovered skills (.deepcoder/skills, Phase 7C)",
          "/memory [sub]    show | remember <fact> | forget <pattern> | inbox | accept <n> | reject <n>",
          "/index [code|symbols [name]|impact <file>|tests <file>]  index/symbols/impact/test-targeting (8C)",
          "/isolation [s]   workspace isolation: status|diff|apply|discard|path",
          "/checks          list configured verification checks",
          "/check <name>    run a configured check (gated, bounded, quarantined)",
          "/solve <chk> <t> edit→run check→retry until it passes or budget runs out",
          "/checkpoint [l]  snapshot agent edits as an undo point (if enabled)",
          "/checkpoints     list checkpoints",
          "/rollback <id>   undo agent edits to a checkpoint ([--force] for conflicts)",
          "/save            save the session now",
          "/status          git status",
          "/diff            git diff",
          "/models          show the model routing table (Phase 10F)",
          "/model [role] [provider/model|model]  inspect/set session model override",
          "/model reset <role|all>  clear session model override",
          "/effort [<role>] <low|medium|high>  set reasoning effort",
          "/effort reset <role|all|>  clear effort override",
          "/delegate plan <task>  build a delegation plan",
          "/delegate plan preflight <task>  build a context-aware delegation plan (runs explorer)",
          "/delegate run <plan-id> [worker-id]  run one worker or all runnable workers sequentially",
          "/delegate status <plan-id>  show worker status table (+ conflict hints from run artifacts)",
          "/delegate review <plan-id>  show full plan for human review",
          "/delegate review-ui <plan-id> [worker-id]  interactive patch review browser (TTY; --no-tui for static)",
          "/delegate apply <plan-id> <worker-id>  apply a passed worker's patch to the real repo",
          "/delegate discard <plan-id> <worker-id>  discard a worker (mark as discarded)",
          "/tests [target|plan|run-targeted]  Phase 10H — automatic minimal test targeting",
        ].join("\n"),
      );
      return { consumed: true };

    case "goal":
      await runGoalSlash(session, arg, save);
      return { consumed: true };

    default:
      console.log(chalk.dim(`Unknown command: /${cmd}. Try /help.`));
      return { consumed: true };
  }
}

/**
 * Read the current session goal from the persisted session file.
 * Returns `undefined` when no goal is stored or the file is absent/corrupt.
 */
async function readSessionGoal(workspaceRoot: string, storeId: string): Promise<SessionGoal | undefined> {
  try {
    const persisted: PersistedSession = await loadSession(workspaceRoot, storeId);
    if (persisted.goal && typeof persisted.goal.objective === "string") {
      // Validate that the persisted goal has the expected shape.
      const g = persisted.goal;
      if (["active", "paused", "done"].includes(g.status) && typeof g.createdAt === "string" && typeof g.updatedAt === "string") {
        return g as SessionGoal;
      }
    }
  } catch {
    // Session file may not exist yet on first save
  }
  return undefined;
}

/**
 * Persist a session goal by reading the current session file, updating it,
 * and writing it back atomically.  This bypasses repl.ts's snapshot function
 * (which we cannot modify), writing directly to the persisted session JSON.
 */
async function persistGoal(
  workspaceRoot: string,
  storeId: string,
  goal: SessionGoal | undefined,
): Promise<void> {
  const dir = path.join(workspaceRoot, ".deepcoder", "sessions");
  const file = path.join(dir, `${storeId}.json`);
  const tmp = `${file}.tmp`;

  let data: PersistedSession;
  try {
    data = await loadSession(workspaceRoot, storeId);
  } catch {
    // If the session file doesn't exist yet, create a minimal record.
    data = { id: storeId, model: "", messages: [], todos: [], readTracker: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as PersistedSession;
  }
  data.goal = goal;
  data.updatedAt = new Date().toISOString();

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Handle `/goal` slash command.
 *
 * Syntax:
 *   /goal                        — show current goal
 *   /goal set <objective>        — set a new goal
 *   /goal update <objective>     — update objective, preserve createdAt
 *   /goal pause [reason]         — pause goal
 *   /goal resume                 — resume goal
 *   /goal done [note]            — mark goal done
 *   /goal clear                  — remove goal
 */
async function runGoalSlash(
  session: Session,
  arg: string,
  _save: () => Promise<void>,
): Promise<void> {
  const workspaceRoot = session.config.workspaceRoot;
  const storeId = session.store.id;

  // Load current goal from persisted session.
  let goal = await readSessionGoal(workspaceRoot, storeId);

  if (!arg) {
    // No argument: display current goal.
    console.log(renderGoal(goal));
    return;
  }

  const [sub, ...rest] = arg.split(/\s+/);
  const subArg = rest.join(" ").trim();

  switch (sub) {
    case "set": {
      if (!subArg) {
        console.log(chalk.dim("usage: /goal set <objective>"));
        return;
      }
      try {
        goal = setGoal(subArg);
        await persistGoal(workspaceRoot, storeId, goal);
        console.log(chalk.dim("Goal set."));
      } catch (e) {
        console.log(chalk.red((e as Error).message));
      }
      return;
    }

    case "update": {
      if (!subArg) {
        console.log(chalk.dim("usage: /goal update <objective>"));
        return;
      }
      try {
        goal = updateGoal(goal, subArg);
        await persistGoal(workspaceRoot, storeId, goal);
        console.log(chalk.dim("Goal updated."));
      } catch (e) {
        console.log(chalk.red((e as Error).message));
      }
      return;
    }

    case "pause": {
      if (!goal) {
        console.log(chalk.dim("No active goal. Use /goal set <objective>."));
        return;
      }
      goal = pauseGoal(goal, subArg || undefined);
      await persistGoal(workspaceRoot, storeId, goal);
      console.log(chalk.dim(subArg ? `Goal paused: ${subArg}` : "Goal paused."));
      return;
    }

    case "resume": {
      if (!goal) {
        console.log(chalk.dim("No active goal. Use /goal set <objective>."));
        return;
      }
      try {
        goal = resumeGoal(goal);
        await persistGoal(workspaceRoot, storeId, goal);
        console.log(chalk.dim("Goal resumed."));
      } catch (e) {
        console.log(chalk.red((e as Error).message));
      }
      return;
    }

    case "done": {
      if (!goal) {
        console.log(chalk.dim("No active goal. Use /goal set <objective>."));
        return;
      }
      goal = completeGoal(goal, subArg || undefined);
      await persistGoal(workspaceRoot, storeId, goal);
      console.log(chalk.dim(subArg ? `Goal marked done: ${subArg}` : "Goal marked done."));
      return;
    }

    case "clear": {
      goal = undefined;
      await persistGoal(workspaceRoot, storeId, undefined);
      console.log(chalk.dim("Goal cleared."));
      return;
    }

    default:
      console.log(chalk.dim("usage: /goal [set <objective> | update <objective> | pause [reason] | resume | done [note] | clear]"));
  }
}

async function readWorkerRunChangedFiles(
  root: string,
  planId: string,
  workerId: string,
): Promise<string[] | null> {
  try {
    assertSafeId(planId);
    assertSafeId(workerId);
    const p = path.join(root, ".deepcoder", "delegations", planId, "runs", workerId, "run.json");
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerRun>;
    if (!Array.isArray(parsed.changedFiles)) return null;
    return parsed.changedFiles.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  critical: chalk.red.bold,
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.dim,
};

const LOG_MAX_BYTES = 80 * 1024;
const LOG_MAX_LINES = 2000;

interface TriageArgs {
  scope?: string;
  file?: string;
  failure?: string;
  /** A saved/quarantined check-run id whose log should be triaged. */
  run?: string;
}

/** Parse `/triage` args: `--file <path>`, `--scope <scope>`, rest = pasted failure text. */
export function parseTriageArgs(arg: string): TriageArgs {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const out: TriageArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--file" && i + 1 < tokens.length) out.file = tokens[++i];
    else if (tokens[i] === "--scope" && i + 1 < tokens.length) out.scope = tokens[++i];
    else if (tokens[i] === "--run" && i + 1 < tokens.length) out.run = tokens[++i];
    else rest.push(tokens[i]!);
  }
  if (rest.length) out.failure = rest.join(" ");
  return out;
}

/**
 * Read a workspace log file for triage input: in-workspace, non-sensitive, and
 * bounded (80 KB / 2000 lines). A direct fs read — NOT the read_file tool — so
 * it never touches readTracker (a log read must not satisfy read-before-write).
 */
export function readLogInput(
  workspaceRoot: string,
  relPath: string,
): { text: string; truncated: boolean } | { error: string } {
  if (isSensitivePath(relPath)) return { error: `Refusing to read ${relPath}: it may contain secrets.` };
  let abs: string;
  try {
    // Symlink-safe: rejects a link pointing outside the workspace.
    abs = resolveReadPathInWorkspace(workspaceRoot, relPath);
  } catch (err) {
    return { error: (err as Error).message };
  }
  // Re-check sensitivity on the real (symlink-resolved) path.
  if (isSensitivePath(displayPath(workspaceRoot, abs))) {
    return { error: `Refusing to read ${relPath}: it resolves to a path that may contain secrets.` };
  }

  // Bounded read: only the first LOG_MAX_BYTES are pulled off disk (a huge log
  // must never be slurped whole into memory), then line-limited.
  let raw: string;
  let truncated = false;
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const size = fstatSync(fd).size;
    const toRead = Math.min(size, LOG_MAX_BYTES);
    const buf = Buffer.alloc(toRead);
    const n = readSync(fd, buf, 0, toRead, 0);
    raw = buf.subarray(0, n).toString("utf8");
    if (size > LOG_MAX_BYTES) truncated = true;
  } catch (err) {
    return { error: `Could not read ${relPath}: ${(err as Error).message}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const lines = raw.split("\n");
  if (lines.length > LOG_MAX_LINES) {
    raw = lines.slice(0, LOG_MAX_LINES).join("\n");
    truncated = true;
  }
  return { text: raw, truncated };
}

/**
 * Shared driver for read-only subagent slash commands (/review, /research):
 * fresh abort signal + SIGINT, run, render, and persist ONLY to the quarantined
 * session.reviews metadata (never into model-visible history).
 */
async function runSubagentCommand(
  session: Session,
  save: () => Promise<void>,
  profile: SubagentProfile,
  task: string,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  console.log(chalk.dim(`Running ${profile.name} subagent (read-only)…`));
  try {
    const { result, trace } = await runSubagent(profile, task, {
      workspaceRoot: session.config.workspaceRoot,
      provider: session.provider,
      parentModel: session.config.model,
      subagentModel: session.config.subagentModel,
      contextBudgetTokens: session.config.contextBudgetTokens,
      compactAt: session.config.compactAt,
      signal: controller.signal,
    });
    renderSubagentResult(result, trace);
    // Untrusted, model-authored output → quarantined metadata only, never assistant history.
    session.reviews.push({ createdAt: new Date().toISOString(), result, trace });
    await save();
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function renderSubagentResult(result: SubagentResult, trace: SubagentTrace): void {
  const summary = result.summary || chalk.dim("(no answer produced)");
  console.log("\n" + chalk.bold(`${result.profile}> `) + summary);
  for (const f of result.findings) {
    const color = SEVERITY_COLOR[f.severity] ?? chalk.white;
    const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    console.log(`  ${color(`[${f.severity}]`)}${loc} ${f.claim}`);
    if (f.evidence) console.log(chalk.dim(`      ${f.evidence}`));
  }
  for (const s of result.suggestedNextSteps) console.log(chalk.dim(`  → ${s}`));
  if (result.errors.length) console.log(chalk.yellow(`  (${result.errors.join("; ")})`));
  console.log(chalk.dim(`  · ${result.profile} · ${trace.toolsCalled.length} tool calls · ${trace.turns} turns · ${trace.model}`));
  console.log(chalk.dim("  (advisory — make any changes yourself; this subagent cannot edit or run anything)"));
}

/** Render `/instructions [show|sources|conflicts|reload]` against the graph (8A). */
function printInstructionGraph(session: Session, sub: string): void {
  // `reload` rescans instruction files, bumps the version, and replaces the live
  // graph. It does NOT rewrite existing transcript messages (only future calls).
  if (sub === "reload") {
    const prev = session.instructionGraph!;
    const next = resolveInstructions(session.config).graph;
    if (next) {
      next.version = String((Number(prev.version) || 0) + 1);
      session.instructionGraph = next;
      console.log(chalk.dim(`reloaded instruction graph (version ${next.version}, ${next.sources.filter((s) => !s.skipped).length} sources).`));
      console.log(chalk.yellow("note: applies to future model calls; existing conversation messages are unchanged."));
    }
    return;
  }

  const g = session.instructionGraph!;
  const root = session.config.workspaceRoot;
  const relOf = (p: string): string => {
    const r = path.relative(root, p);
    return r === "" || r.startsWith("..") ? p : r;
  };

  if (sub === "conflicts") {
    const conflicts = g.warnings.filter((w) => w.kind === "conflict");
    if (!conflicts.length) console.log(chalk.dim("no instruction conflicts detected."));
    for (const c of conflicts) console.log(chalk.yellow(`conflict: ${(c as { message: string }).message}`));
    return;
  }

  if (sub === "sources") {
    if (!g.sources.length) console.log(chalk.dim("no instruction sources loaded."));
    for (const s of g.sources) {
      const tags = [s.kind, s.loadedAt, `${s.bytes}b`];
      if (s.importedBy) tags.push(`imported by ${path.basename(s.importedBy)}`);
      if (s.skipped) tags.push(chalk.dim(`skipped: ${s.skipReason ?? "?"}`));
      console.log(`${chalk.cyan(relOf(s.path))} ${chalk.dim(`(${tags.join(" · ")})`)}`);
    }
    for (const w of g.warnings) {
      if (w.kind === "conflict") continue;
      console.log(chalk.yellow(`  ⚠ ${w.kind}: ${w.message}`));
    }
    return;
  }

  // show (default): the rendered startup block + any JIT additions.
  if (!g.renderedStartupText.trim()) {
    console.log(chalk.dim("no startup instructions (no supported instruction files found)."));
  } else {
    console.log(chalk.dim(`(instruction graph v${g.version})\n`) + g.renderedStartupText);
  }
  const jit = Object.values(g.renderedJitTextBySourceId);
  if (jit.length) {
    console.log(chalk.dim("\n— JIT path-local additions —"));
    for (const t of jit) console.log(t);
  }
}

/**
 * Shared `/skills activate` + `/$` slash activation (Phase 7C2). Slash invocation
 * is modelRequested:false (so disableModelInvocation skills are allowed but
 * userInvocable:false ones are refused). On success the bounded, redacted skill
 * text is injected as a normal user message — it becomes part of the transcript
 * (and is preserved verbatim on resume), without mutating the system prompt.
 */
const execFileP = promisify(execFile);

/** Phase 10D — `/plugins [trust|untrust <name>]`: discover plugins + manage trust/enablement.
 *  Trust is persisted in <root>/.deepcoder/plugin-trust.json; default untrusted/disabled. */
async function runPlugins(session: Session, arg: string): Promise<void> {
  const root = session.config.workspaceRoot;
  const storePath = path.join(root, ".deepcoder", "plugin-trust.json");
  const loadStore = async (): Promise<PluginTrustStore> => {
    try { return JSON.parse(await fs.readFile(storePath, "utf8")) as PluginTrustStore; }
    catch { return { plugins: {} }; }
  };
  const plugins = await discoverPlugins(root, os.homedir());
  const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
  const name = rest.join(" ");

  if (sub === "trust" || sub === "untrust") {
    const p = plugins.find((x) => x.manifest.name === name);
    if (!p) { console.log(chalk.dim(`No discovered plugin named "${name}".`)); return; }
    const store = applyTrust(await loadStore(), pluginTrustKey(p), sub === "trust" ? "trusted" : "untrusted");
    await fs.mkdir(path.join(root, ".deepcoder"), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2));
    console.log(chalk.dim(`Plugin "${name}" ${sub === "trust" ? "trusted + enabled" : "untrusted + disabled"}.`));
    return;
  }

  if (plugins.length === 0) {
    console.log(chalk.dim("No plugins discovered (.deepcoder/plugins, .agents/plugins, ~/.deepcoder/plugins)."));
    return;
  }
  const store = await loadStore();
  console.log(chalk.bold(`\nPlugins (${plugins.length}):`));
  for (const p of plugins) {
    const t = resolvePluginTrust(p, store);
    const mark = t.enabled ? chalk.green("●") : chalk.dim("○");
    console.log(`  ${mark} ${p.manifest.name} ${chalk.dim(`[${p.source}] ${t.state}`)} — ${p.manifest.description}`);
  }
  console.log(chalk.dim("  /plugins trust <name> · /plugins untrust <name>"));
}

/**
 * Phase 8F — `/understand`: enumerate tracked files, key the repo by (path,mtime),
 * reuse a cached structured summary when fresh, else compute + persist one. Wires
 * the understand producer + cache.
 */
/**
 * Phase 10L — initialise session overrides on the model router if not already set.
 */
function ensureSessionOverrides(session: Session): SessionModelOverrides {
  if (!session.modelRouter.sessionOverrides) {
    session.modelRouter.sessionOverrides = emptySessionModelOverrides();
  }
  return session.modelRouter.sessionOverrides;
}

/**
 * Phase 10L — `/model` slash command.
 *
 * /model                          → print all routes with sources
 * /model <role>                   → inspect one resolved role
 * /model <role> <provider>/<model> → set session override (with provider)
 * /model <role> <model>           → set session override (keep current provider)
 * /model reset <role>             → clear override for one role
 * /model reset all                → clear all role overrides
 */
async function runModelSlash(session: Session, arg: string): Promise<void> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);

  // ── /model (no args) — print all routes ────────────────────────────
  if (parts.length === 0) {
    const routes = session.modelRouter.explain();
    console.log(chalk.bold("Model routes:"));
    for (const r of routes) {
      const src = chalk.dim(`[${r.source}]`);
      const effort = r.reasoningEffort ? ` · effort ${r.reasoningEffort}` : "";
      console.log(`  ${chalk.cyan(r.role.padEnd(14))} ${r.provider}/${r.model} ${src}${effort}`);
    }
    console.log("");
    console.log(chalk.dim("Use: /model <role> <provider>/<model>"));
    return;
  }

  // ── /model reset <role|all> ────────────────────────────────────────
  if (parts[0] === "reset") {
    const target = parts[1];
    if (!target) {
      console.log(chalk.dim("usage: /model reset <role|all>"));
      return;
    }
    if (target !== "all" && !isValidRole(target)) {
      console.log(chalk.red(`Unknown role "${target}". Valid roles: ${ALL_ROLES.join(", ")}`));
      return;
    }
    const overrides = ensureSessionOverrides(session);
    session.modelRouter.sessionOverrides = clearModelOverride(overrides, target as ModelRole | "all");
    if (target === "all") {
      console.log(chalk.dim("All model overrides cleared for this session."));
    } else {
      console.log(chalk.dim(`Model override cleared for "${target}".`));
    }
    return;
  }

  // ── /model <role> [target] ─────────────────────────────────────────
  const role = parts[0];
  if (!isValidRole(role)) {
    console.log(chalk.red(`Unknown role "${role}". Valid roles: ${ALL_ROLES.join(", ")}`));
    return;
  }

  // ── /model <role> (inspect only) ───────────────────────────────────
  if (parts.length === 1) {
    const route = session.modelRouter.resolve(role);
    const src = chalk.dim(`[${route.source}]`);
    const effort = route.reasoningEffort ? ` · effort ${route.reasoningEffort}` : "";
    console.log(`${role}: ${route.provider}/${route.model} ${src}${effort}`);
    console.log(chalk.dim(`fallbacks: ${session.modelRouter.fallbackChain(role).join(", ") || "none"}`));
    return;
  }

  // ── /model <role> <target> ─────────────────────────────────────────
  const targetInput = parts.slice(1).join(" ");
  let parsed: { provider?: string; model: string };
  try {
    parsed = parseModelTarget(targetInput);
  } catch (err) {
    console.log(chalk.red((err as Error).message));
    return;
  }

  const overrides = ensureSessionOverrides(session);
  session.modelRouter.sessionOverrides = applyModelOverride(overrides, role, parsed);
  const display = parsed.provider ? `${parsed.provider}/${parsed.model}` : parsed.model;
  console.log(chalk.dim(`${role} route set for this session: ${display}`));
}

/**
 * Phase 10L — `/effort` slash command.
 *
 * /effort                     → show current effort defaults + overrides
 * /effort <low|medium|high>   → set default session effort
 * /effort <role> <level>      → set role-specific effort
 * /effort reset <role>        → clear role effort override
 * /effort reset all           → clear all effort overrides
 */
async function runEffortSlash(session: Session, arg: string): Promise<void> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);

  // ── /effort (no args) — show current state ─────────────────────────
  if (parts.length === 0) {
    const overrides = session.modelRouter.sessionOverrides;
    const globalEffort = overrides?.defaultReasoningEffort;
    const hasRoleEfforts = overrides && Object.values(overrides.roles).some((o) => o?.reasoningEffort !== undefined);

    if (globalEffort) {
      console.log(chalk.dim(`global reasoning effort: ${globalEffort}`));
    } else {
      // Show the base config effort as a hint
      const baseEffort = session.config.reasoningEffort ?? "none";
      console.log(chalk.dim(`global reasoning effort: ${baseEffort} [config]`));
    }

    if (hasRoleEfforts) {
      console.log(chalk.dim("session overrides:"));
      for (const [r, ov] of Object.entries(overrides!.roles)) {
        if (ov?.reasoningEffort) {
          console.log(chalk.dim(`  ${r}: ${ov.reasoningEffort}`));
        }
      }
    } else {
      console.log(chalk.dim("session overrides: none"));
    }
    console.log("");
    console.log(chalk.dim("Use: /effort <low|medium|high>  or  /effort <role> <level>"));
    return;
  }

  // ── /effort reset <role|all> ───────────────────────────────────────
  if (parts[0] === "reset") {
    const target = parts[1];
    if (!target) {
      console.log(chalk.dim("usage: /effort reset <role|all>"));
      return;
    }
    if (target !== "all" && !isValidRole(target)) {
      console.log(chalk.red(`Unknown role "${target}". Valid roles: ${ALL_ROLES.join(", ")}`));
      return;
    }
    const overrides = ensureSessionOverrides(session);
    session.modelRouter.sessionOverrides = clearEffortOverride(overrides, target as ModelRole | "all");
    if (target === "all") {
      console.log(chalk.dim("All effort overrides cleared for this session."));
    } else {
      console.log(chalk.dim(`Effort override cleared for "${target}".`));
    }
    return;
  }

  // ── /effort <level>  OR  /effort <role> <level> ───────────────────
  if (parts.length === 1) {
    const level = parts[0];
    if (!isValidEffort(level)) {
      console.log(chalk.red(`Invalid effort level "${level}". Use: low, medium, or high.`));
      return;
    }
    const overrides = ensureSessionOverrides(session);
    session.modelRouter.sessionOverrides = applyEffortOverride(overrides, level);
    console.log(chalk.dim(`Default reasoning effort set for this session: ${level}`));
    return;
  }

  if (parts.length >= 2) {
    const role = parts[0];
    if (!isValidRole(role)) {
      console.log(chalk.red(`Unknown role "${role}". Valid roles: ${ALL_ROLES.join(", ")}`));
      return;
    }
    const level = parts[1];
    if (!isValidEffort(level)) {
      console.log(chalk.red(`Invalid effort level "${level}". Use: low, medium, or high.`));
      return;
    }
    const overrides = ensureSessionOverrides(session);
    session.modelRouter.sessionOverrides = applyEffortOverride(overrides, level, role);
    console.log(chalk.dim(`${role} effort set for this session: ${level}`));
    return;
  }

  // Fallback: usage
  console.log(chalk.dim("usage: /effort [<role>] <low|medium|high>  |  /effort reset <role|all>"));
}

/**
 * Phase 10F — resolve the "delegate" role into a worker model override. Returns
 * undefined when the route is the default (no env/file override), so delegated
 * workers inherit the parent's model byte-identically unless explicitly routed.
 */
function resolveDelegateOverride(session: Session): WorkerModelOverride | undefined {
  const route = session.modelRouter?.resolve("delegate");
  if (!route || route.source === "default") return undefined;
  return { provider: route.provider, model: route.model, baseUrl: route.baseUrl };
}

async function runUnderstand(session: Session): Promise<void> {
  const root = session.config.workspaceRoot;
  let files: { path: string; mtimeMs: number }[] = [];
  try {
    const { stdout } = await execFileP("git", ["ls-files"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const paths = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    files = await Promise.all(
      paths.map(async (p) => {
        let mtimeMs = 0;
        try { mtimeMs = (await fs.stat(path.join(root, p))).mtimeMs; } catch { /* ignored/deleted */ }
        return { path: p, mtimeMs };
      }),
    );
  } catch {
    console.log(chalk.dim("/understand: not a git repo (or git unavailable) — cannot enumerate files."));
    return;
  }
  const key = computeRepoKey(files);
  let entry = await readUnderstandCache(root, key);
  const cached = entry !== null;
  if (!entry) {
    entry = { key, createdAt: new Date().toISOString(), data: summarizeRepo(files) };
    await writeUnderstandCache(root, entry);
  }
  const u = entry.data as ReturnType<typeof summarizeRepo>;
  const exts = Object.entries(u.byExtension)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([e, n]) => `${e || "(none)"}:${n}`).join("  ");
  console.log(chalk.bold(`\nRepo understanding ${chalk.dim(cached ? "(cached)" : "(fresh)")}`));
  console.log(`  files:     ${u.fileCount}`);
  console.log(`  top dirs:  ${u.topDirs.join(", ") || "—"}`);
  console.log(`  key files: ${u.keyFiles.join(", ") || "—"}`);
  console.log(`  by ext:    ${exts}`);
}

/**
 * Phase 8E — `/index`: build the semantic vector store. Enumerates tracked
 * files, chunks them (gated by shouldChunkFile), embeds each chunk via the
 * configured embedding provider, and persists the store the semantic-search
 * tools query. Opt-in: requires semantic search enabled + a reachable embedding
 * backend (default-off; fail-closed with a clear message otherwise).
 */
async function runIndex(session: Session): Promise<void> {
  const root = session.config.workspaceRoot;
  const cfg = session.config.semanticSearch;
  if (!cfg.enabled) {
    console.log(chalk.dim("/semantic: semantic search is disabled. Enable it with DEEPCODER_SEMANTIC_SEARCH=1 and a local embedding backend."));
    return;
  }
  const provider = createEmbeddingProvider(cfg);
  if (!provider) {
    console.log(chalk.red(`/semantic: no embedding provider for "${cfg.provider}". Configure a local backend (e.g. ollama).`));
    return;
  }
  let paths: string[];
  try {
    const { stdout } = await execFileP("git", ["ls-files"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    paths = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    console.log(chalk.dim("/semantic: not a git repo (or git unavailable) — cannot enumerate files."));
    return;
  }
  const files: { path: string; content: string }[] = [];
  for (const p of paths) {
    try { files.push({ path: p, content: await fs.readFile(path.join(root, p), "utf8") }); }
    catch { /* skip unreadable/binary/deleted */ }
  }
  console.log(chalk.dim(`/semantic: chunking ${files.length} file(s) and embedding via ${cfg.provider}/${cfg.model}…`));
  try {
    const res = await buildSemanticIndex({
      root,
      files,
      embed: (texts) => provider.embed(texts),
      providerLabel: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    });
    console.log(chalk.green(`/semantic: built ${res.chunkCount} chunk(s) from ${files.length - res.skipped.length} file(s); ${res.skipped.length} skipped.`));
  } catch (err) {
    console.log(chalk.red(`/semantic: failed — ${(err as Error).message}`));
  }
}

/**
 * Phase 10O — `/copy` implementation.
 *
 * Parses arguments, builds the copy payload from session data, redacts and
 * bounds it, then copies to clipboard (or prints with --print).
 */
async function runCopySlash(session: Session, arg: string): Promise<void> {
  const parsed = parseCopyArgs(arg);
  if (!parsed.ok) {
    console.log(chalk.dim(parsed.error));
    return;
  }

  const { target, printOnly } = parsed;
  let payload: CopyPayload | null = null;

  try {
    switch (target.kind) {
      case "last": {
        payload = extractLatestAssistant(session.messages);
        if (!payload) {
          console.log(chalk.dim("No assistant response to copy yet."));
          return;
        }
        break;
      }

      case "code": {
        payload = extractLatestCodeBlock(session.messages);
        if (!payload) {
          console.log(chalk.dim("No code block found in assistant responses."));
          return;
        }
        break;
      }

      case "diff": {
        const root = session.executionRoot ?? session.config.workspaceRoot;
        const git = new Git(root);
        if (!(await git.isRepo())) {
          console.log(chalk.dim("Not a git repository — cannot copy diff."));
          return;
        }
        const diffText = await git.diff();
        if (!diffText) {
          console.log(chalk.dim("No unstaged changes to copy."));
          return;
        }
        const lineCount = diffText.split("\n").length;
        payload = buildCopyPayload(`git diff (${lineCount} lines)`, diffText);
        break;
      }

      case "goal": {
        console.log(chalk.dim("goal copying requires Phase 10M /goal"));
        return;
      }

      case "plan": {
        // Find the latest `/plan` assistant response
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const msg = session.messages[i];
          if (msg && msg.role === "assistant") {
            const prevMsg = session.messages[i - 1];
            if (prevMsg && prevMsg.role === "user" && prevMsg.content.startsWith("/plan ")) {
              payload = buildCopyPayload("plan", msg.content);
              break;
            }
          }
        }
        if (!payload) {
          console.log(chalk.dim("No plan found. Create one with /plan <task>."));
          return;
        }
        break;
      }

      case "check": {
        // Phase 10O — load a saved check run by id
        try {
          const root = session.config.workspaceRoot;
          const loaded = await loadCheckRun(root, target.runId);
          payload = buildCopyPayload(
            `check run ${loaded.run.name} (exit ${loaded.run.exitCode ?? "?"})`,
            `Command: ${loaded.run.command}\n\n${loaded.log}`,
          );
        } catch {
          console.log(chalk.red(`Check run "${target.runId}" not found. See /triage --run`));
          return;
        }
        break;
      }

      case "worker": {
        // Phase 10O — load a worker artifact (patch, log, or review summary)
        try {
          const root = session.config.workspaceRoot;
          const artifacts = await loadWorkerArtifacts(root, target.planId, target.workerId);
          if (target.part === "patch") {
            const text = artifacts.patchText || artifacts.patchPreview;
            if (text) {
              payload = buildCopyPayload(`worker ${target.workerId} patch`, text);
            } else {
              console.log(chalk.dim(`No patch found for worker "${target.workerId}".`));
              return;
            }
          } else if (target.part === "log") {
            const text = artifacts.runLogPreview;
            if (text) {
              payload = buildCopyPayload(`worker ${target.workerId} log`, text);
            } else {
              console.log(chalk.dim(`No run log found for worker "${target.workerId}".`));
              return;
            }
          } else {
            // review
            const text = artifacts.qualityArtifact || artifacts.telemetryPreview;
            if (text) {
              payload = buildCopyPayload(`worker ${target.workerId} review`, text);
            } else {
              console.log(chalk.dim(`No review summary found for worker "${target.workerId}".`));
              return;
            }
          }
        } catch {
          console.log(chalk.red(`Worker "${target.workerId}" in plan "${target.planId}" not found.`));
          return;
        }
        break;
      }
    }
  } catch (err) {
    console.log(chalk.red(`Copy failed: ${(err as Error).message}`));
    return;
  }

  if (!payload) {
    console.log(chalk.dim("Nothing to copy."));
    return;
  }

  if (printOnly) {
    console.log(chalk.dim(`--- ${payload.label} (${payload.bytes} bytes${payload.truncated ? ", truncated" : ""}) ---`));
    console.log(payload.text);
    return;
  }

  // Try to copy to clipboard
  const result = await copyToClipboard(payload.text);
  if (result.ok) {
    const backend = result.backend ? chalk.dim(` (via ${result.backend})`) : "";
    console.log(chalk.dim(`copied ${payload.label} (${payload.bytes} chars)${payload.truncated ? ", truncated" : ""}${backend}`));
  } else {
    // Fallback: print with a clear warning
    console.log(chalk.yellow(`clipboard unavailable: ${result.error}`));
    console.log("");
    console.log(chalk.dim(`--- ${payload.label} (${payload.bytes} bytes${payload.truncated ? ", truncated" : ""}) ---`));
    const preview = payload.text.length > 2000 ? payload.text.slice(0, 2000) + "\n... (truncated preview)" : payload.text;
    console.log(preview);
  }
}

/**
 * Build a bounded, redacted CopyPayload from raw text.
 */
function buildCopyPayload(label: string, text: string): CopyPayload {
  const MAX_BYTES = 256 * 1024;
  const redacted = redactSecrets(text);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= MAX_BYTES) {
    return { label, text: redacted, bytes, truncated: false };
  }
  const truncated = Buffer.from(redacted, "utf8").subarray(0, MAX_BYTES).toString("utf8");
  return {
    label,
    text: truncated + "\n... (truncated)",
    bytes: MAX_BYTES,
    truncated: true,
  };
}

async function activateSkillSlash(session: Session, name: string, args: string): Promise<void> {
  const res = await activateSkill(
    { name, arguments: args, modelRequested: false },
    skillsRuntime(session),
  );
  if (!res.ok || !res.modelText) {
    console.log(chalk.red(res.message));
    return;
  }
  session.messages.push({ role: "user", content: res.modelText });
  const rec = res.record;
  console.log(chalk.green(res.message));
  if (rec) console.log(chalk.dim(`body: ${(rec.bodyBytes / 1024).toFixed(1)} KiB${rec.arguments ? `, arguments: ${rec.arguments}` : ""}`));
}
