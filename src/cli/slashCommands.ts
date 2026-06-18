import chalk from "chalk";
import type { ApprovalMode } from "../config/config.js";
import { Git } from "../workspace/git.js";
import { loadInstructions } from "../context/projectInstructions.js";
import { renderTodos } from "../tools/todoWrite.js";
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
