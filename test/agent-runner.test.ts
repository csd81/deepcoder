import { test } from "node:test";
import assert from "node:assert/strict";
import { uiEventToSdkEvent, EventQueue } from "../src/server/agentRunner.js";
import type { SdkEvent } from "../src/sdk/events.js";

test("[agent-runner] uiEventToSdkEvent maps the public events", () => {
  assert.deepEqual(uiEventToSdkEvent({ type: "assistant_delta", text: "hi" }), { type: "assistant.delta", text: "hi" });
  assert.deepEqual(uiEventToSdkEvent({ type: "tool_start", name: "read_file", description: "read a" }), { type: "tool.call", name: "read_file", description: "read a" });
  assert.deepEqual(uiEventToSdkEvent({ type: "tool_result", name: "read_file", output: "x", isError: false }), { type: "tool.result", name: "read_file", output: "x", isError: false });
  assert.deepEqual(uiEventToSdkEvent({ type: "notice", message: "hey" }), { type: "notice", message: "hey" });
});

test("[agent-runner] assistant_done has no direct SDK shape (caller emits the message)", () => {
  assert.equal(uiEventToSdkEvent({ type: "assistant_done" }), null);
  assert.equal(uiEventToSdkEvent({ type: "status", patch: {} }), null);
});

test("[agent-runner] EventQueue: items pushed before iteration are drained in order, then close ends it", async () => {
  const q = new EventQueue<SdkEvent>();
  q.push({ type: "assistant.delta", text: "a" });
  q.push({ type: "assistant.delta", text: "b" });
  q.close();
  const got: string[] = [];
  for await (const ev of q) if (ev.type === "assistant.delta") got.push(ev.text);
  assert.deepEqual(got, ["a", "b"]);
});

test("[agent-runner] EventQueue: a waiter pending before push resolves on push", async () => {
  const q = new EventQueue<SdkEvent>();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next(); // no items yet → waits
  q.push({ type: "notice", message: "later" });
  const r = await pending;
  assert.equal(r.done, false);
  assert.deepEqual(r.value, { type: "notice", message: "later" });
});
