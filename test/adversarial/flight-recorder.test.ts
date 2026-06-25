import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FlightRecorder,
  listFlightCalls,
  reconstituteCall,
} from "../../src/session/flightRecorder.js";
import { isSensitivePath } from "../../src/workspace/sensitive.js";
import type { AgentMessage, ChatRequest } from "../../src/providers/types.js";

const SID = "2026-06-25T00-00-00-bbbb";
const SECRET = "sk-LEAKME-supersecret-000";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-flight-"));
}

function req(messages: AgentMessage[]): ChatRequest {
  return { messages, tools: [], model: "m" };
}

test("[SECURITY] secrets in captured content are redacted in the written blob", async () => {
  const root = await ws();
  const rec = new FlightRecorder(root, SID);
  await rec.recordCall(
    req([{ role: "tool", content: `tool output: DEEPSEEK_API_KEY=${SECRET}`, toolCallId: "t1" }]),
  );

  // Every blob on disk must be free of the raw secret.
  const blobsDir = path.join(root, ".deepcoder", "flight", SID, "blobs");
  for (const name of await readdir(blobsDir)) {
    const body = await readFile(path.join(blobsDir, name), "utf8");
    assert.ok(!body.includes(SECRET), `raw secret leaked into blob ${name}`);
  }
  // And the reconstituted payload is the redacted form, not the original.
  const got = await reconstituteCall(root, SID, 0);
  assert.ok(!got.messages[0].content.includes(SECRET));
  assert.ok(got.messages[0].content.includes("***"), "a redaction marker is present");
});

test("[SECURITY] a crafted sessionId cannot escape the flight directory", () => {
  const root = "/tmp/whatever";
  for (const bad of ["../evil", "..", "a/../../b", "/abs/path", "x/y"]) {
    assert.throws(() => new FlightRecorder(root, bad), /Invalid id/, bad);
  }
});

test("[SECURITY] flight reads reject a traversal sessionId", async () => {
  const root = await ws();
  await assert.rejects(() => listFlightCalls(root, "../escape"), /Invalid id/);
  await assert.rejects(() => reconstituteCall(root, "../escape", 0), /Invalid id/);
});

test("[SECURITY] .deepcoder/flight is unreadable by tools (re-ingestion blocked)", () => {
  // The recorder relies on the existing sensitive-path guard to keep the agent
  // from reading its own flight logs. Lock that assumption here.
  assert.equal(isSensitivePath(`.deepcoder/flight/${SID}/call_0000.json`), true);
  assert.equal(isSensitivePath(`.deepcoder/flight/${SID}/blobs/abc123`), true);
});
