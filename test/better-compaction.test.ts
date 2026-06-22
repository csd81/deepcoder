import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredSummary } from "../src/context/compaction.js";

// Red-seed anchor (do NOT weaken). Deterministic structured recap built from
// session data — NO live model. (The optional /compact --deep LLM path is out of scope.)
const msg = (role: "user" | "assistant", content: string) => ({ role, content });

test("structured summary includes the task, files touched, and unresolved todos", () => {
  const out = buildStructuredSummary(
    [msg("user", "Fix the auth bug"), msg("assistant", "looking into it")] as never,
    new Set(["src/auth.ts"]),          // read
    new Set(["src/auth.ts"]),          // written
    [{ id: "1", content: "add a regression test", status: "pending" }] as never,
  );
  assert.match(out, /Fix the auth bug/, "task from the first user message");
  assert.match(out, /auth\.ts/, "files from the trackers");
  assert.match(out, /regression test/i, "remaining todo");
});

test("structured summary is markdown with sections", () => {
  const out = buildStructuredSummary([msg("user", "do X")] as never, new Set(), new Set(), [] as never);
  assert.match(out, /^##? /m, "has markdown headings");
});
