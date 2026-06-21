/**
 * Phase 10A (slice 1) — pure UI core. SEED (red-first) anchor: pins the
 * transcript reducer contract (assistant deltas coalesce into one block) so a
 * delegated worker MUST implement the pure event/transcript model (no
 * green-check no-op), then EXTENDS this file with the remaining pure cases from
 * plans/phase10a-scrollable-terminal-ui-plan.md (Testing → Pure tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscript, applyEvent } from "../../src/ui/transcript.js";

test("[transcript-assistant-delta] assistant deltas coalesce into one block", () => {
  let t = createTranscript();
  t = applyEvent(t, { type: "assistant_delta", text: "Hello " });
  t = applyEvent(t, { type: "assistant_delta", text: "world" });
  const assistant = t.blocks.filter((b) => b.kind === "assistant");
  assert.equal(assistant.length, 1, "streamed deltas append into a single assistant block");
  assert.equal(assistant[0].body, "Hello world");
});
