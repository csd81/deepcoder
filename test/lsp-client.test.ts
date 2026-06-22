import { test } from "node:test";
import assert from "node:assert/strict";
import { createLspClient } from "../src/lsp/client.js";
import type {
  JsonRpcConnection,
  LspLocation,
  LspDiagnostic,
} from "../src/lsp/types.js";

interface RecordedCall {
  kind: "request" | "notify";
  method: string;
  params?: unknown;
}

/** A scriptable fake JsonRpcConnection for unit-testing the client. */
class FakeConnection implements JsonRpcConnection {
  calls: RecordedCall[] = [];
  disposed = false;
  /** method -> canned result for request() */
  results = new Map<string, unknown>();
  /** method -> registered notification handler */
  handlers = new Map<string, (params: unknown) => void>();

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ kind: "request", method, params });
    return this.results.has(method) ? this.results.get(method) : null;
  }

  notify(method: string, params?: unknown): void {
    this.calls.push({ kind: "notify", method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler);
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Test helper: push a server→client notification. */
  push(method: string, params: unknown): void {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`no handler for ${method}`);
    h(params);
  }

  methodOrder(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const ROOT = "file:///workspace";

test("createLspClient sends initialize request then initialized notification", async () => {
  const conn = new FakeConnection();
  await createLspClient(conn, ROOT);

  const init = conn.calls[0];
  assert.equal(init.kind, "request");
  assert.equal(init.method, "initialize");
  const params = init.params as {
    processId: unknown;
    rootUri: string;
    capabilities: object;
  };
  assert.equal(params.rootUri, ROOT);
  assert.deepEqual(params.capabilities, {});

  const second = conn.calls[1];
  assert.equal(second.kind, "notify");
  assert.equal(second.method, "initialized");

  // order: initialize strictly before initialized
  assert.ok(
    conn.methodOrder().indexOf("initialize") <
      conn.methodOrder().indexOf("initialized"),
  );
});

test("diagnostics() returns cached diagnostics after publishDiagnostics", async () => {
  const conn = new FakeConnection();
  const client = await createLspClient(conn, ROOT);

  const uri = "file:///workspace/a.ts";
  assert.deepEqual(client.diagnostics(uri), []);

  const diags: LspDiagnostic[] = [
    {
      severity: 1,
      message: "boom",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
    },
  ];
  conn.push("textDocument/publishDiagnostics", { uri, diagnostics: diags });

  assert.deepEqual(client.diagnostics(uri), diags);
  // unknown uri still empty
  assert.deepEqual(client.diagnostics("file:///workspace/other.ts"), []);
});

test("didOpen sends textDocument/didOpen notification", async () => {
  const conn = new FakeConnection();
  const client = await createLspClient(conn, ROOT);

  const uri = "file:///workspace/a.ts";
  client.didOpen(uri, "typescript", "const x = 1;");

  const call = conn.calls.find((c) => c.method === "textDocument/didOpen");
  assert.ok(call);
  assert.equal(call.kind, "notify");
  assert.deepEqual(call.params, {
    textDocument: { uri, languageId: "typescript", version: 1, text: "const x = 1;" },
  });
});

const LOC: LspLocation = {
  uri: "file:///workspace/b.ts",
  range: {
    start: { line: 3, character: 2 },
    end: { line: 3, character: 9 },
  },
};

test("definition() normalizes a single Location object", async () => {
  const conn = new FakeConnection();
  conn.results.set("textDocument/definition", LOC);
  const client = await createLspClient(conn, ROOT);

  const result = await client.definition("file:///workspace/a.ts", {
    line: 1,
    character: 1,
  });
  assert.deepEqual(result, LOC);

  const call = conn.calls.find((c) => c.method === "textDocument/definition");
  assert.ok(call);
  assert.equal(call.kind, "request");
  assert.deepEqual(call.params, {
    textDocument: { uri: "file:///workspace/a.ts" },
    position: { line: 1, character: 1 },
  });
});

test("definition() normalizes an array to its first element", async () => {
  const conn = new FakeConnection();
  conn.results.set("textDocument/definition", [LOC, { ...LOC, uri: "x" }]);
  const client = await createLspClient(conn, ROOT);

  const result = await client.definition("file:///workspace/a.ts", {
    line: 1,
    character: 1,
  });
  assert.deepEqual(result, LOC);
});

test("definition() returns null when server returns null", async () => {
  const conn = new FakeConnection();
  conn.results.set("textDocument/definition", null);
  const client = await createLspClient(conn, ROOT);

  const result = await client.definition("file:///workspace/a.ts", {
    line: 1,
    character: 1,
  });
  assert.equal(result, null);
});

test("definition() returns null for an empty array", async () => {
  const conn = new FakeConnection();
  conn.results.set("textDocument/definition", []);
  const client = await createLspClient(conn, ROOT);

  const result = await client.definition("file:///workspace/a.ts", {
    line: 0,
    character: 0,
  });
  assert.equal(result, null);
});

test("references() returns the array of locations", async () => {
  const conn = new FakeConnection();
  const locs = [LOC, { ...LOC, uri: "file:///workspace/c.ts" }];
  conn.results.set("textDocument/references", locs);
  const client = await createLspClient(conn, ROOT);

  const result = await client.references("file:///workspace/a.ts", {
    line: 2,
    character: 4,
  });
  assert.deepEqual(result, locs);

  const call = conn.calls.find((c) => c.method === "textDocument/references");
  assert.ok(call);
  assert.equal(call.kind, "request");
  assert.deepEqual(call.params, {
    textDocument: { uri: "file:///workspace/a.ts" },
    position: { line: 2, character: 4 },
    context: { includeDeclaration: false },
  });
});

test("references() returns [] when server returns null", async () => {
  const conn = new FakeConnection();
  conn.results.set("textDocument/references", null);
  const client = await createLspClient(conn, ROOT);

  const result = await client.references("file:///workspace/a.ts", {
    line: 0,
    character: 0,
  });
  assert.deepEqual(result, []);
});

test("stop() sends shutdown request, exit notification, then disposes", async () => {
  const conn = new FakeConnection();
  const client = await createLspClient(conn, ROOT);
  conn.calls = []; // ignore init traffic

  await client.stop();

  const shutdown = conn.calls.find((c) => c.method === "shutdown");
  const exit = conn.calls.find((c) => c.method === "exit");
  assert.ok(shutdown);
  assert.equal(shutdown.kind, "request");
  assert.ok(exit);
  assert.equal(exit.kind, "notify");

  // order: shutdown before exit
  const order = conn.methodOrder();
  assert.ok(order.indexOf("shutdown") < order.indexOf("exit"));
  assert.equal(conn.disposed, true);
});
