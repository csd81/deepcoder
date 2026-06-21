/**
 * Phase 10B slice 3 — stdio JSON-RPC server core (pure, no real stdio, no TCP).
 *
 * Builds on slice-2 DeepcoderClient. The testable core takes an INJECTED write
 * sink and processes JSON-RPC request lines — no process.stdin/stdout coupling,
 * no auth (stdio = parent owns the pipe), no network.
 *
 * Deliverables (each tagged [10B3-*]):
 *   [10B3-health]  method "health" -> JSON-RPC result {ok:true}
 *   [10B3-parse]   a malformed JSON line -> JSON-RPC parse error (-32700), no throw
 *   [10B3-unknown] an unknown method -> JSON-RPC method-not-found error (-32601)
 *   [10B3-run]     method "runTask" -> streams each SdkEvent as a notification,
 *                  then a final response carrying the run result with the same id
 *   [10B3-redact]  event notifications are redacted (no raw key escapes)
 *
 * RED ANCHOR: imports from src/server/stdioServer.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SdkEvent } from "../../src/sdk/events.js";
import { DeepcoderClient } from "../../src/sdk/client.js";
import { createStdioServer } from "../../src/server/stdioServer.js";

function fakeRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "hello" };
  })();
}

test("[10B3-health] health method returns ok result", async () => {
  const sent: unknown[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health" }));
  const resp = sent.find((m: any) => m.id === 1) as any;
  assert.ok(resp, "a response was written for id 1");
  assert.equal(resp.result?.ok, true);
});

test("[10B3-parse] malformed JSON yields a parse error and does not throw", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine("{not valid json");
  const err = sent.find((m) => m.error);
  assert.ok(err, "an error response was written");
  assert.equal(err.error.code, -32700, "JSON-RPC parse error code");
});
