import type { UiEvent } from "./events.js";

/**
 * Headless "print" renderer for `--print` / `-p` one-shot runs.
 *
 * Emits ONLY the assistant's text — raw, uncolored, with no `assistant>` header,
 * no tool/notice/status chrome — so the output is clean to capture, pipe, or
 * assert on when dogfooding prompts non-interactively. Each finalized assistant
 * message is written on its own line; empty assistant turns (tool-only) write
 * nothing.
 */
export function createPrintRenderer(opts: {
  write: (s: string) => void;
}): {
  emit(event: UiEvent): void;
  endTurn(): void;
} {
  let buf = "";

  const flush = (): void => {
    if (buf.length === 0) return;
    opts.write(buf + "\n");
    buf = "";
  };

  return {
    emit(event: UiEvent) {
      switch (event.type) {
        case "assistant_delta":
          buf += event.text;
          break;
        case "assistant_done":
          flush();
          break;
        // Everything else (tool calls/results, notices, status, approvals,
        // checks, workers) is deliberately suppressed in print mode.
        default:
          break;
      }
    },
    endTurn() {
      flush();
    },
  };
}
