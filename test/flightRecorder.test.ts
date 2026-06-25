import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FlightRecorder,
  listFlightCalls,
  reconstituteCall,
} from "../src/session/flightRecorder.js";
import { getResponse, sanitizeForProvider } from "../src/agent/agentLoop.js";
import type { AgentDeps } from "../src/agent/agentLoop.js";
import type { AgentMessage, ChatRequest } from "../src/providers/types.js";
import { ScriptedProvider, makeCtx } from "./helpers/providers.js";
import { defaultRegistry } from "../src/tools/registry.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "flight-"));
}

function req(messages: AgentMessage[]): ChatRequest {
  return { messages, tools: [{ name: "read_file", description: "d", parameters: {} }], model: "m" };
}

const SID = "2026-06-25T00-00-00-aaaa";

test("record then reconstitute round-trips byte-identical messages/tools/model", async () => {
  const root = await ws();
  const rec = new FlightRecorder(root, SID);
  const messages: AgentMessage[] = [
    { role: "system", content: "You are deepcoder." },
    { role: "user", content: "fix the bug" },
    { role: "system", content: "Current todo list:\n- [pending] fix" }, // ephemeral injection
  ];
  const idx = await rec.recordCall(req(messages));
  assert.equal(idx, 0);

  const got = await reconstituteCall(root, SID, 0);
  assert.deepEqual(got.messages, messages);
  assert.equal(got.model, "m");
  assert.equal(got.tools.length, 1);
});

test("call index advances across calls and listFlightCalls reflects it", async () => {
  const root = await ws();
  const rec = new FlightRecorder(root, SID);
  await rec.recordCall(req([{ role: "user", content: "a" }]));
  await rec.recordCall(req([{ role: "user", content: "b" }]));
  assert.deepEqual(await listFlightCalls(root, SID), [0, 1]);
});

test("identical content across calls dedups to one blob", async () => {
  const root = await ws();
  const rec = new FlightRecorder(root, SID);
  const shared = "x".repeat(5000);
  await rec.recordCall(req([{ role: "user", content: shared }]));
  await rec.recordCall(req([{ role: "user", content: shared }]));
  const blobs = await readdir(path.join(root, ".deepcoder", "flight", SID, "blobs"));
  // shared content (1) + tools schema (1) = 2 distinct blobs, despite 2 calls.
  assert.equal(blobs.length, 2);
});

test("eviction keeps the last N calls and GCs orphan blobs", async () => {
  const root = await ws();
  const rec = new FlightRecorder(root, SID, { maxCalls: 2 });
  for (let i = 0; i < 5; i++) {
    await rec.recordCall(req([{ role: "user", content: `unique-${i}-${"y".repeat(100)}` }]));
  }
  assert.deepEqual(await listFlightCalls(root, SID), [3, 4]);
  // Only blobs referenced by calls 3 & 4 (their contents + the shared tools blob) survive.
  const blobs = await readdir(path.join(root, ".deepcoder", "flight", SID, "blobs"));
  assert.equal(blobs.length, 3); // content_3 + content_4 + tools
});

test("getResponse fires onModelCall once with the sanitized payload", async () => {
  const root = await ws();
  const captured: ChatRequest[] = [];
  // An orphan tool message (no owning assistant call) must be dropped by sanitize.
  const messages: AgentMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", content: "orphan", toolCallId: "nope" },
  ];
  const deps = {
    provider: new ScriptedProvider([{ text: "done", toolCalls: [] }]),
    registry: defaultRegistry(),
    ctx: makeCtx(root),
    model: "m",
    onModelCall: (r: ChatRequest) => {
      captured.push(r);
    },
  } as unknown as AgentDeps;

  await getResponse(deps, messages);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].messages, sanitizeForProvider(messages));
});
