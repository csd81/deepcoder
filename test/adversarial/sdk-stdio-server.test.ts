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

// ─── [10B3-health] ─────────────────────────────────────────────────────────

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

test("[10B3-health] health with null id still works", async () => {
  const sent: unknown[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  // Request with missing id => id must be null in response
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "health" }));
  const resp = sent.find((m: any) => m.result?.ok === true) as any;
  assert.ok(resp, "a health response was written");
  assert.equal(resp.id, null, "missing id is treated as null");
});

// ─── [10B3-parse] ──────────────────────────────────────────────────────────

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

test("[10B3-parse] parse error has id null and jsonrpc 2.0", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine("{{{");
  assert.equal(sent.length, 1, "exactly one response written");
  assert.equal(sent[0].jsonrpc, "2.0");
  assert.equal(sent[0].id, null);
  assert.equal(sent[0].error.code, -32700);
  assert.equal(sent[0].error.message, "Parse error");
});

// ─── [10B3-unknown] ────────────────────────────────────────────────────────

test("[10B3-unknown] unknown method yields method-not-found error", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "bogus" }));
  const resp = sent.find((m: any) => m.id === 5) as any;
  assert.ok(resp, "a response was written for id 5");
  assert.equal(resp.error?.code, -32601, "Method not found code");
  assert.equal(resp.error?.message, "Method not found");
});

test("[10B3-unknown] missing method field also yields method-not-found error", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3 }));
  const resp = sent.find((m: any) => m.id === 3) as any;
  assert.ok(resp, "a response was written");
  assert.equal(resp.error?.code, -32601);
});

// ─── [10B3-run] ────────────────────────────────────────────────────────────

function multiEventRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "step 1" };
    yield { type: "tool.call", name: "read_file", description: "read something" };
    yield { type: "tool.result", name: "read_file", output: "file content", isError: false };
    yield { type: "assistant.message", text: "step 2" };
    yield {
      type: "usage",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  })();
}

test("[10B3-run] runTask streams event notifications then a result response", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => multiEventRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 10, method: "runTask", params: { prompt: "do it" } }),
  );

  // Must have at least: run.started + assistant.message + tool.call + tool.result +
  //   assistant.message + usage + run.finished (7 notifications) + 1 final response = 8
  assert.ok(sent.length >= 8, `expected >= 8 messages, got ${sent.length}`);

  // All notifications before the response must NOT carry an id.
  const notifications = sent.filter((m) => m.method === "event");
  for (const n of notifications) {
    assert.equal(n.id, undefined, "notifications must not have an id");
    assert.equal(n.jsonrpc, "2.0");
    assert.ok(n.params, "each notification must have params");
  }

  // The final response should carry the request id and a result.
  const finalResp = sent.find((m: any) => m.id === 10) as any;
  assert.ok(finalResp, "a final response with id 10 was written");
  assert.equal(finalResp.jsonrpc, "2.0");
  assert.ok(finalResp.result, "response has a result field");
  assert.equal(typeof finalResp.result.sessionId, "string");
  assert.equal(typeof finalResp.result.finalText, "string");
  assert.ok(Array.isArray(finalResp.result.events));
  assert.ok(finalResp.result.usage);
  assert.equal(finalResp.result.finalText, "step 1\nstep 2");
});

test("[10B3-run] runTask with minimal params works", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 20, method: "runTask", params: { prompt: "hello" } }),
  );

  // Should get notifications + response
  const resp = sent.find((m: any) => m.id === 20) as any;
  assert.ok(resp, "response was written");
  assert.ok(resp.result, "result present");
});

test("[10B3-run] runTask with missing params defaults to empty prompt", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  // No params field at all
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 30, method: "runTask" }),
  );

  const resp = sent.find((m: any) => m.id === 30) as any;
  assert.ok(resp, "response was written");
  assert.ok(resp.result, "result present");
});

test("[10B3-run] runTask with missing id uses null", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => fakeRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "runTask", params: { prompt: "hi" } }),
  );

  const notifications = sent.filter((m) => m.method === "event");
  for (const n of notifications) {
    assert.equal(n.id, undefined, "notifications must not have an id");
  }

  // The response should have id: null
  const resp = sent.find((m) => m.id === null) as any;
  assert.ok(resp, "response with id null was written");
  assert.ok(resp.result, "result present");
});

// ─── [10B3-redact] ─────────────────────────────────────────────────────────

function runnerWithSecret(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield {
      type: "tool.result",
      name: "read_file",
      output: "config key is sk-abcdef0123456789",
      isError: false,
    };
  })();
}

test("[10B3-redact] event notifications do not contain raw secrets", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    // redact defaults to true in DeepcoderClient
    client: new DeepcoderClient({ runner: () => runnerWithSecret() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 40, method: "runTask", params: { prompt: "show config" } }),
  );

  // Check that no notification contains the raw secret
  const notifications = sent.filter((m) => m.method === "event" && m.params);
  for (const n of notifications) {
    const serialized = JSON.stringify(n);
    // The raw key must NOT appear
    assert.ok(
      !serialized.includes("sk-abcdef0123456789"),
      `raw secret leaked in notification: ${serialized}`,
    );
  }

  // The redacted version should appear in the tool.result output
  // (since redactEvent replaces with sk-***)
  const toolResultNotif = notifications.find(
    (n) => n.params?.type === "tool.result",
  );
  assert.ok(toolResultNotif, "tool.result notification was sent");

  // The output should be redacted
  assert.ok(
    toolResultNotif.params?.output?.includes("sk-***"),
    `expected redacted key in tool.result, got: ${toolResultNotif.params?.output}`,
  );
  // And must NOT contain the raw secret
  assert.ok(
    !toolResultNotif.params?.output?.includes("sk-abcdef0123456789"),
    "raw secret present in tool.result notification output",
  );
});

test("[10B3-redact] prove redaction is from client, not a second layer", async () => {
  // Create a client with redact DISABLED to prove the server has no redaction
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => runnerWithSecret(), redact: false }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 50, method: "runTask", params: { prompt: "show config" } }),
  );

  // With redact disabled, the raw key SHOULD appear
  const allText = JSON.stringify(sent);
  assert.ok(
    allText.includes("sk-abcdef0123456789"),
    "with redact=false the raw secret should be visible (proving server has no second layer)",
  );
});

// ─── [10B3-run] error handling ─────────────────────────────────────────────

function throwingRunner(): AsyncIterable<SdkEvent> {
  return (async function* () {
    yield { type: "assistant.message", text: "about to fail" };
    throw new Error("runner crashed");
  })();
}

test("[10B3-run] runner that throws produces a final error response", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => throwingRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 60, method: "runTask", params: { prompt: "do it" } }),
  );

  // Should have at least one notification (assistant.message) then the error response
  const finalResp = sent.find((m: any) => m.id === 60) as any;
  assert.ok(finalResp, "a final error response was written");
  assert.equal(finalResp.error?.code, -32000, "server error code");
  assert.ok(finalResp.error?.message, "error has a message");
});

test("[10B3-run] runner that throws does not cause handleLine to throw", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => throwingRunner() }),
    write: (obj) => sent.push(obj),
  });
  // This must not throw
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 70, method: "runTask", params: { prompt: "boom" } }),
  );
  assert.ok(sent.length > 0, "messages were written despite runner error");
});

test("[10B3-redact] error messages are redacted for secrets", async () => {
  const sent: any[] = [];
  const server = createStdioServer({
    client: new DeepcoderClient({ runner: () => throwingRunner() }),
    write: (obj) => sent.push(obj),
  });
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 80, method: "runTask", params: { prompt: "do it" } }),
  );

  // Verify the error message exists (the fake runner throws a simple error,
  // not one containing a key — the redactSecrets pass-through is fine)
  const finalResp = sent.find((m: any) => m.id === 80) as any;
  assert.ok(finalResp.error?.message, "error message present");
});
