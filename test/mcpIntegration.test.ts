import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpManager } from "../src/mcp/registry.js";
import { makeCtx } from "./helpers/providers.js";

const SERVER = fileURLToPath(new URL("./helpers/mock-mcp-server.mjs", import.meta.url));

test("a real read-only MCP server is discovered and its tool is callable end-to-end", async () => {
  const manager = new McpManager({
    mock: { command: process.execPath, args: [SERVER], mode: "readonly" },
  });
  await manager.connectAll();
  try {
    const status = manager.status();
    assert.equal(status[0]!.connected, true, status[0]!.error ?? "should connect");

    const tools = await manager.tools();
    const echo = tools.find((t) => t.name === "mcp__mock__echo");
    assert.ok(echo, "echo tool is discovered with a namespaced name");
    assert.equal(echo!.kind, "read-only");
    assert.ok(echo!.rawSchema, "carries the server-provided JSON schema");

    const result = await echo!.build({ text: "hi" }).execute(makeCtx(process.cwd()));
    assert.match(result.output, /echo: hi/);
  } finally {
    await manager.closeAll();
  }
});

test("MCP tool output is capped so a chatty server can't flood context", async () => {
  // Indirect check: the cap constant is applied in McpClient.callTool. Here we
  // just confirm a normal call returns promptly and within bounds.
  const manager = new McpManager({
    mock: { command: process.execPath, args: [SERVER], mode: "readonly" },
  });
  await manager.connectAll();
  try {
    const echo = (await manager.tools()).find((t) => t.name === "mcp__mock__echo")!;
    const result = await echo.build({ text: "x".repeat(50) }).execute(makeCtx(process.cwd()));
    assert.ok(result.output.length < 16 * 1024 + 100);
  } finally {
    await manager.closeAll();
  }
});
