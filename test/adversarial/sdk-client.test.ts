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

// ─── Fake runner helpers ────────────────────────────────────────────────────

/** A fake runner: emits a fixed event script, ignoring the model entirely. */
function fakeRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "done" };
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
  })();
}

/** A runner that yields events and respects abort via the signal. */
function abortableRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "first" };
    // Wait long enough for the abort to fire between events
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield { type: "assistant.message", text: "second" };
  })();
}

// ─── [10B2-stream] — streamTask envelope behaviour ────────────────────────

test("[10B2-stream] streamTask throws clear error when no runner configured", async () => {
  const client = new DeepcoderClient();
  await assert.rejects(
    async () => {
      for await (const _ of client.streamTask({ prompt: "hi" })) {
        // noop
      }
    },
    /no runner configured/,
  );
});

test("[10B2-stream] streamTask emits run.started first and run.finished last", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi" })) {
    events.push(ev);
  }

  assert.ok(events.length >= 2, "at least start + finish events");
  assert.equal(events[0]?.type, "run.started");
  assert.equal(events.at(-1)?.type, "run.finished");
});

test("[10B2-stream] streamTask run.started default mode is ask", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  for await (const ev of client.streamTask({ prompt: "hi" })) {
    if (ev.type === "run.started") {
      assert.equal(ev.mode, "ask");
      assert.ok(ev.runId.length > 0);
      assert.ok(ev.sessionId.length > 0);
      break;
    }
  }
});

test("[10B2-stream] streamTask uses provided sessionId and mode", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  for await (const ev of client.streamTask({
    prompt: "hi",
    sessionId: "my-session",
    mode: "auto",
  })) {
    if (ev.type === "run.started") {
      assert.equal(ev.sessionId, "my-session");
      assert.equal(ev.mode, "auto");
      break;
    }
  }
});

// ─── [10B2-redact] — event redaction ───────────────────────────────────────

test("[10B2-redact] key-shaped string is redacted from tool.result when redact is true", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield {
        type: "tool.result",
        name: "bash",
        output: "exported DEEPSEEK_API_KEY=sk-abcdef0123456789 to env",
      };
    })();

  // Default redact = true
  const client = new DeepcoderClient({ runner });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi" })) {
    events.push(ev);
  }

  const toolResult = events.find((e) => e.type === "tool.result");
  assert.ok(toolResult);
  assert.equal(toolResult.type, "tool.result");
  assert.ok(
    !toolResult.output.includes("sk-abcdef0123456789"),
    "raw key must not escape with redact on",
  );
});

test("[10B2-redact] key-shaped string is NOT redacted when redact is false", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield {
        type: "tool.result",
        name: "bash",
        output: "exported DEEPSEEK_API_KEY=sk-abcdef0123456789 to env",
      };
    })();

  const client = new DeepcoderClient({ runner, redact: false });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi" })) {
    events.push(ev);
  }

  const toolResult = events.find((e) => e.type === "tool.result");
  assert.ok(toolResult);
  assert.equal(toolResult.type, "tool.result");
  assert.ok(
    toolResult.output.includes("sk-abcdef0123456789"),
    "raw key must survive with redact off",
  );
});

test("[10B2-redact] run.started and run.finished pass through redactEvent harmlessly", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner(), redact: true });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi" })) {
    events.push(ev);
  }

  const started = events.find((e) => e.type === "run.started")!;
  assert.equal(started.type, "run.started");
  assert.ok(started.runId.length > 0);

  const finished = events.find((e) => e.type === "run.finished")!;
  assert.equal(finished.type, "run.finished");
});

// ─── [10B2-approval] — approval handler ────────────────────────────────────

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

test("[10B2-approval] injected handler can approve", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "approval.requested", tool: "run_bash", preview: "rm -rf /" };
    })();
  const client = new DeepcoderClient({
    runner,
    approvalHandler: async () => "approve",
  });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "x" })) events.push(ev);
  const resolved = events.find((e) => e.type === "approval.resolved");
  assert.ok(resolved && resolved.type === "approval.resolved");
  assert.equal(resolved.approved, true, "injected handler can approve");
});

test("[10B2-approval] sync handler works (not just async)", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "approval.requested", tool: "ls", preview: "list files" };
    })();
  const client = new DeepcoderClient({
    runner,
    approvalHandler: () => "approve",
  });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "x" })) events.push(ev);
  const resolved = events.find((e) => e.type === "approval.resolved")!;
  assert.equal(resolved.approved, true);
});

test("[10B2-approval] handler receives un-redacted preview for decision", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield {
        type: "approval.requested",
        tool: "bash",
        preview: "sk-abcdef0123456789 should still be visible to handler",
      };
    })();
  let handlerReceived: string | undefined;
  const client = new DeepcoderClient({
    runner,
    approvalHandler: (req) => {
      handlerReceived = req.preview as string;
      return "deny";
    },
  });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "x" })) events.push(ev);
  // The handler should get the raw preview (with the key intact)
  assert.ok(handlerReceived?.includes("sk-abcdef0123456789"), "handler sees raw preview");
  // The yielded event should be redacted (key removed)
  const yielded = events.find((e) => e.type === "approval.requested")!;
  if (yielded.type === "approval.requested" && typeof yielded.preview === "string") {
    assert.ok(!yielded.preview.includes("sk-abcdef0123456789"), "yielded event is redacted");
  }
});

// ─── [10B2-collect] — runTask aggregation ───────────────────────────────────

test("[10B2-collect] runTask collects finalText, usage, and events", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const result = await client.runTask({ prompt: "hi" });
  assert.equal(result.finalText, "done");
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(result.usage.promptTokens, 5);
  assert.equal(result.usage.completionTokens, 7);
  assert.equal(result.events[0]?.type, "run.started");
  assert.equal(result.events.at(-1)?.type, "run.finished");
});

test("[10B2-collect] runTask finalText joins multiple assistant.message events with newline", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "assistant.message", text: "hello" };
      yield { type: "assistant.message", text: "world" };
    })();
  const client = new DeepcoderClient({ runner });
  const result = await client.runTask({ prompt: "hi" });
  assert.equal(result.finalText, "hello\nworld");
});

test("[10B2-collect] runTask usage sums multiple usage events", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
      yield { type: "usage", usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 } };
    })();
  const client = new DeepcoderClient({ runner });
  const result = await client.runTask({ prompt: "hi" });
  assert.equal(result.usage.promptTokens, 5);
  assert.equal(result.usage.completionTokens, 7);
  assert.equal(result.usage.totalTokens, 12);
});

test("[10B2-collect] runTask returns zero usage when no usage events", async () => {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "assistant.message", text: "no tokens" };
    })();
  const client = new DeepcoderClient({ runner });
  const result = await client.runTask({ prompt: "hi" });
  assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
});

test("[10B2-collect] runTask returns sessionId from run.started", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const result = await client.runTask({ prompt: "hi", sessionId: "custom-session" });
  assert.equal(result.sessionId, "custom-session");
});

test("[10B2-collect] runTask changedFiles is empty array in this slice", async () => {
  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const result = await client.runTask({ prompt: "hi" });
  assert.deepEqual(result.changedFiles, []);
});

// ─── [10B2-abort] — abort signal handling ──────────────────────────────────

test("[10B2-abort] pre-aborted signal yields run.started then run.finished with status aborted", async () => {
  const ac = new AbortController();
  ac.abort();

  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi", signal: ac.signal })) {
    events.push(ev);
  }

  assert.equal(events[0]?.type, "run.started");
  assert.equal(events.at(-1)?.type, "run.finished");
  const finished = events.at(-1)!;
  assert.equal(finished.type, "run.finished");
  assert.equal(finished.status, "aborted");
  // Exact count: run.started + run.finished = 2 events, no runner events
  assert.equal(events.length, 2);
});

test("[10B2-abort] abort during iteration stops and yields run.finished with status aborted", async () => {
  const ac = new AbortController();

  const client = new DeepcoderClient({ runner: () => abortableRunner() });
  const events: SdkEvent[] = [];

  // Abort after a microtask so the runner starts yielding
  const timer = setTimeout(() => ac.abort(), 5);

  for await (const ev of client.streamTask({ prompt: "hi", signal: ac.signal })) {
    events.push(ev);
  }
  clearTimeout(timer);

  assert.equal(events[0]?.type, "run.started");
  assert.equal(events.at(-1)?.type, "run.finished");
  const finished = events.at(-1)!;
  assert.equal(finished.type, "run.finished");
  assert.equal(finished.status, "aborted", "must be aborted, not ok");
  // run.started + some runner events + run.finished
  assert.ok(events.length >= 2, "at least start and finish");
});

test("[10B2-abort] exactly one run.finished event", async () => {
  const ac = new AbortController();
  ac.abort();

  const client = new DeepcoderClient({ runner: () => fakeRunner() });
  const events: SdkEvent[] = [];
  for await (const ev of client.streamTask({ prompt: "hi", signal: ac.signal })) {
    events.push(ev);
  }

  const finished = events.filter((e) => e.type === "run.finished");
  assert.equal(finished.length, 1, "exactly one run.finished");
});
