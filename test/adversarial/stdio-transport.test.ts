/**
 * Phase 10B — stdio JSON-RPC real transport (pure, injected streams, no real stdio).
 *
 * Newline-delimited JSON-RPC framing over a chunked input stream, wrapping the
 * slice-3 createStdioServer core. push() feeds raw input chunks (which may carry
 * 0..N newlines / a partial line); each COMPLETE line is dispatched to the server
 * and each outbound message is framed as JSON + "\n" to the injected write sink.
 * end() flushes a trailing line that had no newline.
 *
 * Deliverables (tagged [10B6-*]):
 *   [10B6-frame]   a full line in -> one framed JSON response line out (matching id)
 *   [10B6-partial] a line split across two pushes -> dispatched once, on the newline
 *   [10B6-multi]   two lines in one chunk -> two responses
 *   [10B6-end]     a trailing line with no newline is flushed by end()
 *   [10B6-blank]   blank / whitespace-only lines are ignored
 *
 * RED ANCHOR: imports from src/server/stdioTransport.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStdioTransport } from "../../src/server/stdioTransport.js";
import { DeepcoderClient } from "../../src/sdk/client.js";
import type { SdkEvent } from "../../src/sdk/events.js";

function client() {
  const runner = (): AsyncIterable<SdkEvent> =>
    (async function* () {
      yield { type: "assistant.message", text: "ok" };
    })();
  return new DeepcoderClient({ runner });
}

test("[10B6-frame] a full request line yields one framed JSON response with the id", async () => {
  const out: string[] = [];
  const t = createStdioTransport({ client: client(), write: (l) => out.push(l) });
  await t.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health" }) + "\n");
  const resp = out.map((l) => JSON.parse(l)).find((m) => m.id === 1);
  assert.ok(resp, "a response for id 1 was written");
  assert.equal(resp.result?.ok, true);
  assert.ok(out.every((l) => l.endsWith("\n")), "every framed message ends with a newline");
});

test("[10B6-partial] a line split across two pushes is dispatched only once the newline arrives", async () => {
  const out: string[] = [];
  const t = createStdioTransport({ client: client(), write: (l) => out.push(l) });
  await t.push('{"jsonrpc":"2.0","id":7,"meth');
  assert.equal(out.length, 0, "nothing dispatched before the line completes");
  await t.push('od":"health"}\n');
  const resp = out.map((l) => JSON.parse(l)).find((m) => m.id === 7);
  assert.ok(resp && resp.result?.ok === true, "completed line dispatched once");
});
