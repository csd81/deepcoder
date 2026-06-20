import { promises as fs, openSync, readSync, fstatSync, closeSync } from "node:fs";
import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { Git } from "../workspace/git.js";
import { resolveReadPathInWorkspace, displayPath, assertSafeId } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { renderTodos } from "../tools/todoWrite.js";
import type { HookEvent } from "../hooks/types.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { compactIfNeeded } from "../context/compaction.js";
import { listCheckpoints, rollback } from "../session/checkpoints.js";
import { runSubagent } from "../subagents/runner.js";
import { reviewer, researcher, testTriage } from "../subagents/profiles.js";
import { runExplorer } from "../subagents/contextExplorer.js";
import { buildDeterministicPlan } from "../context/contextPlanner.js";
import { renderExplorerBrief } from "../context/explorerBrief.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { resolveBackend } from "../sandbox/index.js";
import { discoverSkills } from "../skills/discovery.js";
import { loadStartupMemory, listTopics, remember, forget } from "../memory/store.js";
import { buildRepoIndex } from "../index/scanner.js";
import { impactedBy, reverseGraph } from "../index/impact.js";
import { relevantTests } from "../index/testTargeting.js";
import { findReferences } from "../index/references.js";
import { saveIndex, loadIndex } from "../index/store.js";
import type { SandboxMode } from "../sandbox/types.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { confirm } from "../permissions/prompt.js";
import { runSolveCommand } from "./solveRunner.js";
import { stdout } from "node:process";
import type { SubagentProfile, SubagentResult, SubagentTrace } from "../subagents/types.js";
import type { AgentMessage } from "../providers/types.js";
import type { Session } from "./repl.js";
import { resolveInstructions } from "./repl.js";
import { buildPlan } from "../delegate/planner.js";
import { buildContextAwarePlan } from "../delegate/contextPlan.js";
import { savePlan, loadPlan } from "../delegate/store.js";
import { runWorker, delegateDepthFromEnv } from "../delegate/workerRunner.js";
import { applyWorker, discardWorker } from "../delegate/apply.js";
import { autoApplyIfEligible } from "../delegate/autoApply.js";
import { runRunnable, detectFileConflicts } from "../delegate/orchestrator.js";
import type { WorkerRun } from "../delegate/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SlashOutcome {
  consumed: boolean;
  exit?: boolean;
}

const MODES: ApprovalMode[] = ["ask", "auto", "readonly"];

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
      if (!parsed.scope && !parsed.file && !parsed.failure) {
        console.log(
          chalk.dim(
            "usage: /triage <failure>  |  /triage --file <path>  |  /triage --scope <scope> <failure>",
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
        });
        const status = run.timedOut
          ? chalk.red("timed out")
          : run.exitCode === 0
            ? chalk.green("passed (exit 0)")
            : chalk.red(`failed (exit ${run.exitCode ?? "?"}${run.signal ? `, ${run.signal}` : ""})`);
        console.log(
          `\n${status} · ${Math.round(run.durationMs)}ms${run.truncated ? " · output truncated" : ""} · run ${run.id}`,
        );
        console.log(chalk.dim(`saved to ${run.logPath} (quarantined; /triage --run integration lands in 5B)`));
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
      } else {
        // show
        const mem = await loadStartupMemory(root);
        const topics = await listTopics(root);
        if (!mem && topics.length === 0) {
          console.log(chalk.dim("No memory yet. Add with /memory remember <fact> (writes .deepcoder/memory/MEMORY.md)."));
        } else {
          if (mem) console.log(mem.trim());
          if (topics.length) console.log(chalk.dim(`\ntopic files: ${topics.join(", ")}`));
        }
      }
      return { consumed: true };
    }

    case "skills": {
      // 7C1: discover + list. `reload` is a no-op marker (discovery is on-demand).
      const skills = await discoverSkills(config.workspaceRoot);
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
      console.log(chalk.dim("(activation lands in a follow-up; this is the 7C1 discovery slice)"));
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

    case "delegate": {
      const [sub, ...subArgs] = arg.split(/\s+/);
      const subArg = subArgs.join(" ").trim();
      const root = config.workspaceRoot;

      if (sub === "plan") {
        if (!subArg) {
          console.log(chalk.dim("usage: /delegate plan <task>  |  /delegate plan preflight <task>"));
          return { consumed: true };
        }

        // Check for the "preflight" trigger: the first token after "plan" is "preflight".
        const [firstToken, ...restTokens] = subArgs;
        const restArg = restTokens.join(" ").trim();

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
        const plan = buildPlan(subArg, { checkNames: Object.keys(config.checks) });
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
        return { consumed: true };
      }

      if (sub === "run") {
        const planId = subArgs[0];
        const workerId = subArgs[1];
        if (!planId) {
          console.log(chalk.dim("usage: /delegate run <plan-id> [worker-id]  — run one worker or all runnable workers sequentially (no auto-apply)"));
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
          console.log(chalk.yellow(`\nThis spawns a live Deepcoder worker (provider: ${config.provider}) in an isolated worktree.`));
          console.log(chalk.dim(`  check:  ${worker.checkName}`));
          console.log(chalk.dim(`  prompt: ${worker.prompt.slice(0, 120)}${worker.prompt.length > 120 ? "…" : ""}`));
          console.log(chalk.dim("  The patch will NOT be applied — review it with /delegate review afterwards."));
          if (!(await confirm(`Run worker "${workerId}"?`))) {
            console.log(chalk.dim("Cancelled."));
            return { consumed: true };
          }
          const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
          const ac = new AbortController();
          try {
            const { run } = await runWorker({
              realRoot: root,
              plan,
              worker,
              signal: ac.signal,
              mainEntry,
              provider: config.provider,
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
            for (const w of run.warnings.slice(0, 10)) console.log(chalk.yellow(`  ! ${w}`));

            const auto = ["1", "true", "yes"].includes((process.env.DEEPCODER_DELEGATE_AUTO_APPLY ?? "").toLowerCase());
            if (run.checkPassed && auto) {
              console.log(chalk.dim("\nAttempting optional auto-apply…"));
              const autoApplyResult = await autoApplyIfEligible(root, planId, workerId, { autoApply: auto, checks: config.checks });
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

        console.log(chalk.yellow(`\nThis spawns live Deepcoder workers (provider: ${config.provider}) sequentially in isolated worktrees.`));
        console.log(chalk.dim("  Only runnable workers (planned/failed with all deps applied) will run."));
        console.log(chalk.dim("  No patch will be applied automatically."));
        if (!(await confirm(`Run all runnable workers in plan "${planId}"?`))) {
          console.log(chalk.dim("Cancelled."));
          return { consumed: true };
        }

        const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
        const ac = new AbortController();
        try {
          const res = await runRunnable(plan, {
            realRoot: root,
            signal: ac.signal,
            mainEntry,
            provider: config.provider,
            delegateDepth: depth,
            onData: (c) => process.stdout.write(c),
          });

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
        const result = await applyWorker(root, planId, workerId, { checks: config.checks });
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

      console.log(chalk.dim("usage: /delegate plan [preflight] <task> | run <plan-id> [worker-id] | status <plan-id> | review <plan-id> | apply <plan-id> <worker-id> | discard <plan-id> <worker-id>"));
      return { consumed: true };
    }

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
          "/triage <fail>   diagnose a failure (also: --file <log>, --scope <scope>)",
          "/sandbox [m]     show sandbox status; set off|fast|local|bubblewrap | network on|off",
          "/hooks [enable|disable]  show lifecycle hooks; toggle them for this session (Phase 7B)",
          "/skills          list discovered skills (.deepcoder/skills, Phase 7C)",
          "/memory [sub]    show | remember <fact> | forget <pattern>  (Phase 8B)",
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
          "/delegate plan <task>  build a delegation plan",
          "/delegate plan preflight <task>  build a context-aware delegation plan (runs explorer)",
          "/delegate run <plan-id> [worker-id]  run one worker or all runnable workers sequentially",
          "/delegate status <plan-id>  show worker status table (+ conflict hints from run artifacts)",
          "/delegate review <plan-id>  show full plan for human review",
          "/delegate apply <plan-id> <worker-id>  apply a passed worker's patch to the real repo",
          "/delegate discard <plan-id> <worker-id>  discard a worker (mark as discarded)",
        ].join("\n"),
      );
      return { consumed: true };

    default:
      console.log(chalk.dim(`Unknown command: /${cmd}. Try /help.`));
      return { consumed: true };
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
}

/** Parse `/triage` args: `--file <path>`, `--scope <scope>`, rest = pasted failure text. */
export function parseTriageArgs(arg: string): TriageArgs {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const out: TriageArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--file" && i + 1 < tokens.length) out.file = tokens[++i];
    else if (tokens[i] === "--scope" && i + 1 < tokens.length) out.scope = tokens[++i];
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
