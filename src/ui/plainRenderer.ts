import chalk from "chalk";
import type { UiEvent } from "./events.js";

export function createPlainRenderer(opts: { write: (s: string) => void }): {
  emit(event: UiEvent): void;
  endTurn(): void;
} {
  let streaming = false;

  return {
    emit(event: UiEvent) {
      switch (event.type) {
        case "assistant_delta":
          if (!streaming) {
            opts.write("\n" + chalk.bold("assistant> "));
            streaming = true;
          }
          opts.write(event.text);
          break;
        case "tool_start":
          if (streaming) {
            opts.write("\n");
            streaming = false;
          }
          opts.write(chalk.dim(`tool ${event.name}: ${event.description}\n`));
          break;
        case "tool_result": {
          const text =
            event.output.length > 800
              ? event.output.slice(0, 800) + "\n…(truncated)"
              : event.output;
          opts.write((event.isError ? chalk.red(text) : chalk.dim(text)) + "\n");
          break;
        }
        case "notice":
          opts.write(chalk.yellow(`\n${event.message}\n`));
          break;
        case "assistant_done":
        case "approval_request":
        case "approval_result":
        case "status":
          // No-ops in plain mode for this slice
          break;
      }
    },
    endTurn() {
      if (streaming) {
        opts.write("\n");
        streaming = false;
      }
    },
  };
}
