import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeNamePart, mcpToolName, McpManager } from "../../src/mcp/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { loadFileConfig } from "../../src/config/fileConfig.js";

const SERVER = fileURLToPath(new URL("../helpers/mock-mcp-server.mjs", import.meta.url));

// --- Finding 4: name sanitization ---

test("sanitizeNamePart maps invalid characters to the provider tool-name alphabet", () => {
  assert.equal(sanitizeNamePart("my server/v2"), "my_server_v2");
  assert.equal(sanitizeNamePart("a.b c!d"), "a_b_c_d");
  assert.match(sanitizeNamePart("***"), /^[A-Za-z0-9_-]+$/); // never empty/invalid
});

test("mcpToolName is always provider-valid and length-capped", () => {
  const name = mcpToolName("server with spaces", "tool/with:punct");
  assert.match(name, /^[A-Za-z0-9_-]+$/);
  assert.ok(name.length <= 64);
  const long = mcpToolName("x".repeat(100), "y".repeat(100));
  assert.ok(long.length <= 64, "over-long names are capped");
});

// --- Finding 3: /mcp reload must not leave stale MCP tools ---

test("unregisterByPrefix drops only MCP tools", () => {
  const reg = new ToolRegistry();
  reg.register({ name: "read_file", description: "", kind: "read-only", schema: undefined, build: () => ({ kind: "read-only", describe: () => "", execute: async () => ({ output: "" }) }) });
  reg.register({ name: "mcp__a__x", description: "", kind: "read-only", rawSchema: { type: "object" }, build: () => ({ kind: "read-only", describe: () => "", execute: async () => ({ output: "" }) }) });
  reg.unregisterByPrefix("mcp__");
  assert.ok(reg.get("read_file"));
  assert.equal(reg.get("mcp__a__x"), undefined);
});

test("registerInto refreshes MCP tools atomically (no stale wrappers)", async () => {
  const reg = new ToolRegistry();
  // Pre-seed a stale MCP tool that no longer exists on any server.
  reg.register({ name: "mcp__mock__ghost", description: "", kind: "read-only", rawSchema: { type: "object" }, build: () => ({ kind: "read-only", describe: () => "", execute: async () => ({ output: "" }) }) });

  const manager = new McpManager({ mock: { command: process.execPath, args: [SERVER], mode: "readonly" } });
  await manager.connectAll();
  try {
    await manager.registerInto(reg);
    assert.equal(reg.get("mcp__mock__ghost"), undefined, "stale tool removed");
    assert.ok(reg.get("mcp__mock__echo"), "current tool registered");
  } finally {
    await manager.closeAll();
  }
});

// --- Findings 1 & 2: cleanup after failure / idempotent close ---

test("a failed connect cleans up and closeAll is safe to call repeatedly", async () => {
  const manager = new McpManager({ broken: { command: "definitely-not-a-real-binary-zzz", args: [] } });
  await manager.connectAll();
  assert.equal(manager.status()[0]!.connected, false);
  // Idempotent: multiple closes must not throw.
  await manager.closeAll();
  await manager.closeAll();
});

test("connect + call + close completes without leaving the event loop alive", async () => {
  // If timeout timers weren't cleared, this test process could hang on exit.
  const manager = new McpManager({ mock: { command: process.execPath, args: [SERVER], mode: "readonly" } });
  await manager.connectAll();
  const echo = (await manager.tools()).find((t) => t.name === "mcp__mock__echo")!;
  await echo.build({ text: "ok" }).execute({ workspaceRoot: process.cwd(), signal: new AbortController().signal, readTracker: new Set(), todos: [] });
  await manager.closeAll();
  assert.ok(true);
});

// --- Finding 5: config validation ---

test("loadFileConfig keeps valid MCP servers and skips invalid ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-cfg-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(
    path.join(root, ".deepcoder", "config.json"),
    JSON.stringify({
      mcpServers: {
        good: { command: "npx", args: ["-y", "x"], mode: "readonly" },
        bad: { args: ["no command"] }, // missing required `command`
        alsoBad: { command: 123 }, // wrong type
      },
    }),
    "utf8",
  );
  const cfg = loadFileConfig(root);
  assert.ok(cfg.mcpServers?.good, "valid entry kept");
  assert.equal(cfg.mcpServers?.bad, undefined, "entry missing command dropped");
  assert.equal(cfg.mcpServers?.alsoBad, undefined, "entry with wrong type dropped");
});

test("loadFileConfig tolerates malformed JSON without throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-cfg2-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "config.json"), "{ not json", "utf8");
  const cfg = loadFileConfig(root);
  assert.deepEqual(cfg, {});
});
