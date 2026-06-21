import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrintRenderer } from "../src/ui/printRenderer.js";

test("print renderer emits only finalized assistant text, raw, suppressing all chrome", () => {
  const out: string[] = [];
  const r = createPrintRenderer({ write: (s) => out.push(s) });
  r.emit({ type: "assistant_delta", text: "Hello " });
  r.emit({ type: "assistant_delta", text: "world" });
  r.emit({ type: "assistant_done" });
  // tool calls, their output, and notices must never reach stdout in print mode.
  r.emit({ type: "tool_start", name: "read_file", description: "read src/x.ts" });
  r.emit({ type: "tool_result", name: "read_file", output: "SECRET FILE CONTENTS", isError: false });
  r.emit({ type: "notice", message: "heads up" });
  r.emit({ type: "status", patch: {} });
  r.endTurn();

  const text = out.join("");
  assert.equal(text, "Hello world\n");
  assert.ok(!text.includes("SECRET FILE CONTENTS"), "tool output is suppressed");
  assert.ok(!text.includes("heads up"), "notices are suppressed");
  assert.ok(!text.includes("read_file"), "tool chrome is suppressed");
  assert.ok(!/assistant>/.test(text), "no assistant> header");
});

test("print renderer separates multiple assistant messages and skips empty ones", () => {
  const out: string[] = [];
  const r = createPrintRenderer({ write: (s) => out.push(s) });
  r.emit({ type: "assistant_delta", text: "Let me check." });
  r.emit({ type: "assistant_done" });
  r.emit({ type: "tool_start", name: "grep", description: "grep" });
  r.emit({ type: "assistant_done" }); // an assistant turn with no text -> nothing written
  r.emit({ type: "assistant_delta", text: "The answer is 4." });
  r.emit({ type: "assistant_done" });
  r.endTurn();

  assert.equal(out.join(""), "Let me check.\nThe answer is 4.\n");
});

test("print renderer flushes trailing buffered text on endTurn even without assistant_done", () => {
  const out: string[] = [];
  const r = createPrintRenderer({ write: (s) => out.push(s) });
  r.emit({ type: "assistant_delta", text: "partial answer" });
  r.endTurn();

  assert.equal(out.join(""), "partial answer\n");
});
