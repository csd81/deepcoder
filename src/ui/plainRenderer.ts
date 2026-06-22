import chalk from "chalk";
import type { UiEvent } from "./events.js";
import { renderRaw } from "./rawMode.js";

/**
 * Plain (non-TUI) renderer for the scrolling CLI.
 *
 * When `renderAssistant` is provided, assistant text is BUFFERED per message and
 * rendered once (markdown + syntax-highlighted code) on `assistant_done` — this
 * is what gives the CLI the same formatting as the TUI. Without it, the renderer
 * falls back to streaming raw deltas live (legacy behavior).
 *
 * When `raw` is true, all output is passed through {@link renderRaw} to strip
 * ANSI escape codes before writing to the terminal.
 */
export function createPlainRenderer(opts: {
  write: (s: string) => void;
  /** Render a finished assistant message to display lines (markdown). */
  renderAssistant?: (text: string) => string[];
  /** When true, strip all ANSI escape codes from output. */
  raw?: boolean;
}): {
  emit(event: UiEvent): void;
  endTurn(): void;
} {
  // Wrap write to strip ANSI when raw mode is active.
  const write = opts.raw ? (s: string) => opts.write(renderRaw(s)) : opts.write;
  // Wrap renderAssistant to strip ANSI from each rendered line.
  let render = opts.renderAssistant;
  if (opts.raw && render) {
    const origRender = render;
    render = (text: string) => origRender(text).map(renderRaw);
  }
  let streaming = false; // legacy raw-streaming in progress
  let buf = ""; // buffered assistant text (render mode)

  const flushAssistant = (): void => {
    if (!render) {
      if (streaming) {
        write("\n");
        streaming = false;
      }
      return;
    }
    if (buf.length === 0) return;
    write("\n" + chalk.bold("assistant>") + "\n");
    for (const line of render(buf)) write(line + "\n");
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
              write("\n" + chalk.bold("assistant> "));
              streaming = true;
            }
            write(event.text);
          }
          break;
        case "assistant_done":
          flushAssistant();
          break;
        case "tool_start":
          flushAssistant(); // finish any pending assistant text first
          write(chalk.dim(`tool ${event.name}: ${event.description}\n`));
          break;
        case "tool_result": {
          const text =
            event.output.length > 800
              ? event.output.slice(0, 800) + "\n…(truncated)"
              : event.output;
          write((event.isError ? chalk.red(text) : chalk.dim(text)) + "\n");
          break;
        }
        case "notice":
          flushAssistant();
          write(chalk.yellow(`\n${event.message}\n`));
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
