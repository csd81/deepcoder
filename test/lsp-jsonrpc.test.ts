import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createJsonRpcConnection } from "../src/lsp/jsonRpc.js";

// Frame a JSON-RPC message the way an LSP peer would (Content-Length framing).
function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

// Parse one (and only one) framed message off a buffer of output bytes.
function parseFirstFrame(buf: Buffer): { headers: string; body: unknown } {
  const sep = buf.indexOf("\r\n\r\n");
  assert.ok(sep >= 0, "expected a header/body separator in output");
  const headers = buf.subarray(0, sep).toString("utf8");
  const match = /Content-Length: (\d+)/i.exec(headers);
  assert.ok(match, "expected a Content-Length header");
  const len = Number(match![1]);
  const bodyStart = sep + 4;
  const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
  assert.equal(body.length, len, "Content-Length must match the body byte length");
  return { headers, body: JSON.parse(body) };
}

// Wait until the output stream has produced at least one full frame.
function nextFrame(output: PassThrough): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString("utf8"));
      if (!match) return;
      const total = sep + 4 + Number(match[1]);
      if (buf.length >= total) {
        output.off("data", onData);
        resolve(buf.subarray(0, total));
      }
    };
    output.on("data", onData);
  });
}

test("notify() writes a correctly Content-Length-framed JSON-RPC message", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createJsonRpcConnection(input, output);

  const framed = nextFrame(output);
  conn.notify("initialized", { hello: "world" });
  const bytes = await framed;

  const { headers, body } = parseFirstFrame(bytes);
  assert.match(headers, /Content-Length: \d+/i);
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    method: "initialized",
    params: { hello: "world" },
  });
  conn.dispose();
});

test("request() resolves with the result of the matching response", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createJsonRpcConnection(input, output);

  const framed = nextFrame(output);
  const pending = conn.request("initialize", { rootUri: "file:///x" });
  const bytes = await framed;
  const { body } = parseFirstFrame(bytes) as { headers: string; body: any };

  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.method, "initialize");
  assert.ok(typeof body.id === "number");

  input.write(frame({ jsonrpc: "2.0", id: body.id, result: { capabilities: { ok: true } } }));

  const result = await pending;
  assert.deepEqual(result, { capabilities: { ok: true } });
  conn.dispose();
});

test("request() rejects when a matching error response arrives", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createJsonRpcConnection(input, output);

  const framed = nextFrame(output);
  const pending = conn.request("definition");
  const bytes = await framed;
  const { body } = parseFirstFrame(bytes) as { headers: string; body: any };

  input.write(frame({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }));

  await assert.rejects(pending, (err: any) => {
    assert.ok(err instanceof Error);
    assert.match(String(err.message), /Method not found/);
    return true;
  });
  conn.dispose();
});

test("onNotification handler fires with the params of an incoming notification", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createJsonRpcConnection(input, output);

  const got = new Promise<unknown>((resolve) => {
    conn.onNotification("textDocument/publishDiagnostics", resolve);
  });

  const params = { uri: "file:///a.ts", diagnostics: [{ message: "boom" }] };
  input.write(frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params }));

  assert.deepEqual(await got, params);
  conn.dispose();
});

test("a response split across two input chunks still parses and resolves", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createJsonRpcConnection(input, output);

  const framed = nextFrame(output);
  const pending = conn.request("hover");
  const bytes = await framed;
  const { body } = parseFirstFrame(bytes) as { headers: string; body: any };

  const full = frame({ jsonrpc: "2.0", id: body.id, result: { contents: "split" } });
  const cut = Math.floor(full.length / 2);
  input.write(full.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 5));
  input.write(full.subarray(cut));

  assert.deepEqual(await pending, { contents: "split" });
  conn.dispose();
});
