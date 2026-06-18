import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { Git } from "../workspace/git.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { renderTodos } from "../tools/todoWrite.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { compactIfNeeded } from "../context/compaction.js";
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
