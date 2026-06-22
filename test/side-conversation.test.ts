import { test } from "node:test";
import assert from "node:assert/strict";
import { forkSide, returnToMain } from "../src/cli/sideConversation.js";

// Red-seed anchor (do NOT weaken). Pure in-memory fork state — no I/O, no model.
// Minimal message objects (structurally an AgentMessage) — runtime only.
const msg = (content: string) => ({ role: "user" as const, content });

test("forkSide deep-copies the main thread (mutating the side copy can't leak back)", () => {
  const main = [msg("hi")];
  const s = forkSide(null, main as never, new Set(["a.ts"]), new Set());
  assert.equal(s.active, true);
  s.sideMessages.push(msg("side-only") as never);
  assert.equal(main.length, 1, "main is untouched");
});

test("returnToMain restores the original messages + trackers", () => {
  const main = [msg("hi")];
  const s = forkSide(null, main as never, new Set(["a.ts"]), new Set(["b.ts"]));
  const r = returnToMain(s);
  assert.equal(r.messages.length, 1);
  assert.ok(r.readTracker.has("a.ts"));
  assert.ok(r.writeTracker.has("b.ts"));
});
