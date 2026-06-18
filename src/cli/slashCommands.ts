import chalk from "chalk";
import type { ApprovalMode, Config } from "../config/config.js";
import type { AgentMessage } from "../providers/types.js";
import { Git } from "../workspace/git.js";

export interface ReplState {
  messages: AgentMessage[];
  mode: ApprovalMode;
}

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
  config: Config,
  state: ReplState,
): Promise<SlashOutcome> {
  if (!input.startsWith("/")) return { consumed: false };

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "exit":
    case "quit":
      return { consumed: true, exit: true };

    case "clear":
      // Keep the system prompt (index 0), drop the rest of the history.
      state.messages.length = 1;
      console.log(chalk.dim("Conversation cleared."));
      return { consumed: true };

    case "mode":
      if (MODES.includes(arg as ApprovalMode)) {
        state.mode = arg as ApprovalMode;
        console.log(chalk.dim(`Approval mode: ${state.mode}`));
      } else {
        console.log(chalk.dim(`Current mode: ${state.mode}. Use one of: ${MODES.join(", ")}`));
      }
      return { consumed: true };

    case "status": {
      const git = new Git(config.workspaceRoot);
      if (await git.isRepo()) console.log(await git.status());
      else console.log(chalk.dim("Not a git repository."));
      return { consumed: true };
    }

    case "diff": {
      const git = new Git(config.workspaceRoot);
      if (await git.isRepo()) {
        const d = await git.diff();
        console.log(d || chalk.dim("No unstaged changes."));
      } else {
        console.log(chalk.dim("Not a git repository."));
      }
      return { consumed: true };
    }

    case "help":
      console.log(
        [
          "/help            show this help",
          "/exit            quit",
          "/clear           clear conversation (keep system prompt)",
          "/mode [m]        show or set approval mode (ask | auto | readonly)",
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
