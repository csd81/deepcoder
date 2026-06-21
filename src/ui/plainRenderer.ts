import chalk from "chalk";
import type { UiEvent } from "./events.js";

/**
 * Plain (non-TUI) renderer for the scrolling CLI.
 *
 * When `renderAssistant` is provided, assistant text is BUFFERED per message and
 * rendered once (markdown + syntax-highlighted code) on `assistant_done` — this
 * is what gives the CLI the same formatting as the TUI. Without it, the renderer
 * falls back to streaming raw deltas live (legacy behavior).
 */
export function createPlainRenderer(opts: {
  write: (s: string) => void;
  /** Render a finished assistant message to display lines (markdown). */
  renderAssistant?: (text: string) => string[];
}): {
  emit(event: UiEvent): void;
  endTurn(): void;
} {
  const render = opts.renderAssistant;
  let streaming = false; // legacy raw-streaming in progress
  let buf = ""; // buffered assistant text (render mode)

  const flushAssistant = (): void => {
    if (!render) {
      if (streaming) {
        opts.write("\n");
        streaming = false;
      }
      return;
    }
    if (buf.length === 0) return;
    opts.write("\n" + chalk.bold("assistant>") + "\n");
    for (const line of render(buf)) opts.write(line + "\n");
    buf = "";
  };

  return {
    emit(event: UiEvent) {
      switch (event.type) {
        case "assistant_delta":
          if (render) {
            buf += event.text; // buffer; render on assistant_done
          } else {
            if (!streaming) {
              opts.write("\n" + chalk.bold("assistant> "));
              streaming = true;
            }
            opts.write(event.text);
          }
          break;
        case "assistant_done":
          flushAssistant();
          break;
        case "tool_start":
          flushAssistant(); // finish any pending assistant text first
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
          flushAssistant();
          opts.write(chalk.yellow(`\n${event.message}\n`));
          break;
        case "approval_request":
        case "approval_result":
        case "status":
          // No-ops in plain mode for this slice
          break;
      }
    },
    endTurn() {
      flushAssistant();
    },
  };
}
