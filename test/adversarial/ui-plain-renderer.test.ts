/**
 * Phase 10A (slice 2) — plain renderer. SEED (red-first): byte-exact spec for the
 * plain-mode renderer, authored by the principal to LOCK current repl output so a
 * delegated worker's refactor stays behavior-preserving. The renderer consumes
 * UiEvents and writes exactly what src/cli/repl.ts writes today; repl is then
 * refactored to EMIT events to it (no output change). No live model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { createPlainRenderer } from "../../src/ui/plainRenderer.js";

function sink() {
  let out = "";
  return { write: (s: string) => { out += s; }, get: () => out };
}

test("[plain-assistant-stream] assistant deltas: header once, raw chunks, newline on endTurn", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  r.emit({ type: "assistant_delta", text: "Hel" });
  r.emit({ type: "assistant_delta", text: "lo" });
  r.endTurn();
  assert.equal(s.get(), "\n" + chalk.bold("assistant> ") + "Hel" + "lo" + "\n");
});

test("[plain-tool-start] tool_start resets active streaming, then writes the dim tool line", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  r.emit({ type: "assistant_delta", text: "x" });
  r.emit({ type: "tool_start", name: "read_file", description: "Read foo" });
  assert.equal(
    s.get(),
    "\n" + chalk.bold("assistant> ") + "x" + "\n" + chalk.dim("tool read_file: Read foo\n"),
  );
});

test("[plain-tool-result] tool_result writes dim text + newline; an error is red", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  r.emit({ type: "tool_result", name: "x", output: "done", isError: false });
  r.emit({ type: "tool_result", name: "y", output: "boom", isError: true });
  assert.equal(s.get(), chalk.dim("done") + "\n" + chalk.red("boom") + "\n");
});

test("[plain-tool-result-trunc] tool_result truncates output past 800 chars (as repl does)", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  const big = "z".repeat(1000);
  r.emit({ type: "tool_result", name: "x", output: big, isError: false });
  assert.equal(s.get(), chalk.dim(big.slice(0, 800) + "\n…(truncated)") + "\n");
});

test("[plain-notice] notice writes a yellow padded line", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  r.emit({ type: "notice", message: "heads up" });
  assert.equal(s.get(), chalk.yellow("\nheads up\n"));
});

test("[plain-endturn-noop] endTurn writes nothing when not mid-stream", () => {
  const s = sink();
  const r = createPlainRenderer({ write: s.write });
  r.emit({ type: "tool_result", name: "x", output: "ok", isError: false });
  const before = s.get();
  r.endTurn();
  assert.equal(s.get(), before, "endTurn only closes an open assistant stream");
});
