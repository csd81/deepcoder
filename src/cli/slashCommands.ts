import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { Git } from "../workspace/git.js";
import { resolveReadPathInWorkspace, displayPath } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { renderTodos } from "../tools/todoWrite.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { compactIfNeeded } from "../context/compaction.js";
import { listCheckpoints, rollback } from "../session/checkpoints.js";
import { runSubagent } from "../subagents/runner.js";
import { reviewer, researcher, testTriage } from "../subagents/profiles.js";
import { runCheck, CheckRefusedError } from "../checks/runner.js";
import { resolveBackend } from "../sandbox/index.js";
import type { SandboxMode } from "../sandbox/types.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { confirm } from "../permissions/prompt.js";
import { runSolveCommand } from "./solveRunner.js";
import { stdout } from "node:process";
import type { SubagentProfile, SubagentResult, SubagentTrace } from "../subagents/types.js";
import type { AgentMessage } from "../providers/types.js";
import type { Session } from "./repl.js";

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

    case "help":
      console.log(
        [
          "/help            show this help",
          "/exit            quit",
          "/clear           clear conversation + todos (keep system prompt)",
          "/mode [m]        show or set approval mode (ask | auto | readonly)",
          "/todos           show the current todo list",
          "/instructions    show loaded project instructions",
          "/context         show context-token usage",
          "/compact         compact conversation history now",
          "/plan <task>     produce a plan with the reasoner model (no tools run)",
          "/mcp [reload]    list configured MCP servers and tools",
          "/review <scope>  run a read-only reviewer subagent over files/topic",
          "/research <q>    run a read-only researcher subagent to explain the codebase",
          "/triage <fail>   diagnose a failure (also: --file <log>, --scope <scope>)",
          "/sandbox [m]     show sandbox status; set off|fast|local|bubblewrap | network on|off",
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
        ].join("\n"),
      );
      return { consumed: true };

    default:
      console.log(chalk.dim(`Unknown command: /${cmd}. Try /help.`));
      return { consumed: true };
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
