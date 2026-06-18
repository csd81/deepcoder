import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { Git } from "../workspace/git.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { renderTodos } from "../tools/todoWrite.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { compactIfNeeded } from "../context/compaction.js";
import { listCheckpoints, rollback } from "../session/checkpoints.js";
import { runSubagent } from "../subagents/runner.js";
import { reviewer, researcher } from "../subagents/profiles.js";
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
