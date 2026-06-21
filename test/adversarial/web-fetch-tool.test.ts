import test from "node:test";
import assert from "node:assert/strict";

import { createWebFetchTool } from "../../src/tools/webFetch.js";
import type { WebDomainPolicy } from "../../src/web/types.js";

const allowExample: WebDomainPolicy = {
  allowedDomains: ["example.com"],
  blockedDomains: [],
};

function makeResponse(body: string, init?: { status?: number; contentType?: string; url?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": init?.contentType ?? "text/plain" },
  });
}

test("[10E-fetchtool-1] createWebFetchTool exposes a read-only web_fetch tool", () => {
  const tool = createWebFetchTool({ web: allowExample, fetchImpl: async () => makeResponse("ok") });

  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.kind, "read-only");
  assert.ok(tool.schema, "tool should expose a zod schema");

  const invocation = tool.build({ url: "https://example.com/docs", maxChars: 20 });
  assert.equal(invocation.kind, "read-only");
  assert.match(invocation.describe(), /https:\/\/example\.com\/docs/);
  assert.equal(invocation.command, undefined);
});

test("[10E-fetchtool-2] execute calls fetchUrl through the injected fetch implementation and returns bounded text", async () => {
  const calls: string[] = [];
  const tool = createWebFetchTool({
    web: allowExample,
    fetchImpl: async (input) => {
      calls.push(String(input));
      return makeResponse("hello from docs");
    },
  });

  const result = await tool.build({ url: "https://example.com/docs", maxChars: 5 }).execute({
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
  });

  assert.deepEqual(calls, ["https://example.com/docs"]);
  assert.equal(result.isError, undefined);
  assert.match(result.output, /hello/);
  assert.doesNotMatch(result.output, /from docs/);
  assert.match(result.output, /truncated/i);
});

test("[10E-fetchtool-3] blocked policy result is returned as a tool error without calling fetch", async () => {
  let called = false;
  const tool = createWebFetchTool({
    web: { allowedDomains: ["docs.example"], blockedDomains: ["blocked.example"] },
    fetchImpl: async () => {
      called = true;
      return makeResponse("should not fetch");
    },
  });

  const result = await tool.build({ url: "https://blocked.example/secret" }).execute({
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
  });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.output, /blocked|denied|not allowed/i);
});

test("[10E-fetchtool-4] output redacts secret-shaped content before returning to the model", async () => {
  const tool = createWebFetchTool({
    web: allowExample,
    fetchImpl: async () => makeResponse("token sk-testsecret1234567890 appears here"),
  });

  const result = await tool.build({ url: "https://example.com/secret" }).execute({
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
    readTracker: new Set(),
    todos: [],
  });

  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.output, /sk-testsecret/);
  assert.match(result.output, /\*\*\*/);
});

test("[10E-fetchtool-5] invalid arguments are rejected by the tool schema", () => {
  const tool = createWebFetchTool({ web: allowExample, fetchImpl: async () => makeResponse("ok") });

  assert.throws(() => tool.build({ url: "not a url" }), /invalid arguments/i);
  assert.throws(() => tool.build({ url: "https://example.com", maxChars: -1 }), /invalid arguments/i);
});

const ctx = () => ({
  workspaceRoot: process.cwd(),
  signal: new AbortController().signal,
  readTracker: new Set<string>(),
  todos: [],
});

test("[10E-quarantine-1] quarantine (default) frames the body as untrusted with a source citation", async () => {
  const tool = createWebFetchTool({
    web: allowExample,
    fetchImpl: async () => makeResponse("the page body text"),
  });
  const result = await tool.build({ url: "https://example.com/docs" }).execute(ctx());
  assert.equal(result.isError, undefined);
  assert.match(result.output, /BEGIN UNTRUSTED WEB CONTENT/);
  assert.match(result.output, /END UNTRUSTED WEB CONTENT/);
  assert.match(result.output, /untrusted/i);
  assert.match(result.output, /example\.com\/docs/);
  assert.match(result.output, /the page body text/);
});

test("[10E-quarantine-2] quarantine hard-caps returned chars to maxReturnedChars even when the model asks for more", async () => {
  const tool = createWebFetchTool({
    web: allowExample,
    quarantine: true,
    maxReturnedChars: 10,
    fetchImpl: async () => makeResponse("X".repeat(500)),
  });
  // The model requests far more than the configured ceiling.
  const result = await tool.build({ url: "https://example.com/big", maxChars: 100000 }).execute(ctx());
  assert.equal(result.isError, undefined);
  const xCount = (result.output.match(/X/g) || []).length;
  assert.ok(xCount <= 10, `expected <=10 body chars to reach history, got ${xCount}`);
  assert.match(result.output, /quarantined/i);
});

test("[10E-quarantine-3] quarantine disabled returns raw bounded text with no untrusted framing", async () => {
  const tool = createWebFetchTool({
    web: allowExample,
    quarantine: false,
    fetchImpl: async () => makeResponse("plain body"),
  });
  const result = await tool.build({ url: "https://example.com/docs" }).execute(ctx());
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.output, /UNTRUSTED WEB CONTENT/);
  assert.match(result.output, /plain body/);
});
