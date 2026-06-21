/**
 * Phase 10B slice 2 — DeepcoderClient event core (pure, no model, no server).
 *
 * Built on the slice-1 event layer (src/sdk/events.ts). Uses an INJECTED runner
 * seam so the whole client is testable with a fake event source — no provider,
 * no agent loop, no CLI.
 *
 * Deliverables (each tagged [10B2-*]):
 *   [10B2-stream]   streamTask emits run.started first and run.finished last,
 *                   with the runner's events in between
 *   [10B2-redact]   every emitted event is passed through redactEvent (no raw key escapes)
 *   [10B2-collect]  runTask aggregates finalText, usage, and the full events list
 *   [10B2-approval] default approval DENIES (emits approval.resolved{approved:false});
 *                   an injected handler can approve
 *   [10B2-abort]    aborting the signal ends the stream with run.finished{status:"aborted"}
 *
 * RED ANCHOR: imports from src/sdk/client.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SdkEvent } from "../../src/sdk/events.js";
import { DeepcoderClient } from "../../src/sdk/client.js";

// A fake runner: emits a fixed event script, ignoring the model entirely.
function fakeRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "done" };
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
  })();
}

test("[10B2-collect] runTask collects finalText, usage, and events", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const result = await client.runTask({ prompt: "hi" });
  assert.equal(result.finalText, "done");
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(result.events[0]?.type, "run.started");
  assert.equal(result.events.at(-1)?.type, "run.finished");
});

test("[10B2-approval] default approval handler denies", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "approval.requested", tool: "run_bash", preview: "rm -rf /" };
    })();
  const client = new DeepcoderClient({ runner });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "x" })) events.push(ev);
  const resolved = events.find((e) => e.type === "approval.resolved");
  assert.ok(resolved && resolved.type === "approval.resolved");
  assert.equal(resolved.approved, false, "headless default must deny");
});
