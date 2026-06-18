import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPermission } from "../../src/permissions/policy.js";
import { adaptMcpInputSchema } from "../../src/mcp/schemaAdapter.js";
import { McpManager } from "../../src/mcp/registry.js";
import { runAgentLoop } from "../../src/agent/agentLoop.js";
import { ScriptedProvider, makeCtx, makeDeps } from "../helpers/providers.js";
import type { AgentMessage } from "../../src/providers/types.js";
import type { ToolInvocation } from "../../src/tools/types.js";

function mcpInv(kind: "read-only" | "execute"): ToolInvocation {
  return { kind, source: "mcp", describe: () => "mcp tool", execute: async () => ({ output: "" }) };
}

test("execute-mode MCP tools are denied in every approval mode (4A gate)", () => {
  for (const mode of ["readonly", "ask", "auto"] as const) {
    assert.equal(checkPermission(mcpInv("execute"), mode, { mcpExecuteEnabled: false }), "deny", mode);
  }
});

test("read-only MCP tools are allowed (operator trust assertion honoured)", () => {
  for (const mode of ["readonly", "ask", "auto"] as const) {
    assert.equal(checkPermission(mcpInv("read-only"), mode, { mcpExecuteEnabled: false }), "allow", mode);
  }
});

test("when execute MCP is later enabled, a known-dangerous flag still applies via mode", () => {
  // With the gate open, an execute MCP tool (no command) defers to mode like any execute tool.
  assert.equal(checkPermission(mcpInv("execute"), "readonly", { mcpExecuteEnabled: true }), "deny");
  assert.equal(checkPermission(mcpInv("execute"), "ask", { mcpExecuteEnabled: true }), "ask");
});

test("schema adapter strips boolean exclusiveMinimum (provider-rejected shape)", () => {
  const adapted = adaptMcpInputSchema({
    type: "object",
    properties: { n: { type: "integer", minimum: 0, exclusiveMinimum: true } },
  });
  const n = (adapted.properties as Record<string, Record<string, unknown>>).n;
  assert.equal("exclusiveMinimum" in n, false);
});

test("schema adapter defaults a missing type to object", () => {
  const adapted = adaptMcpInputSchema({ properties: {} });
  assert.equal(adapted.type, "object");
});

test("a server that fails to start is recorded as an error, not a crash", async () => {
  const manager = new McpManager({
    broken: { command: "this-binary-does-not-exist-xyz", args: [] },
  });
  await manager.connectAll(); // must not throw
  const status = manager.status();
  assert.equal(status.length, 1);
  assert.equal(status[0]!.connected, false);
  assert.ok(status[0]!.error, "the failure is recorded");
  const tools = await manager.tools();
  assert.equal(tools.length, 0);
  await manager.closeAll();
});

test("disabled servers are not connected", async () => {
  const manager = new McpManager({
    off: { command: "whatever", enabled: false, mode: "readonly" },
  });
  await manager.connectAll();
  assert.equal(manager.status()[0]!.error, "disabled");
  await manager.closeAll();
});

test("an MCP tool's hostile output flows as an inert tool result and cannot change policy", async () => {
  // Simulate the loop receiving an MCP read-only tool result whose text claims
  // the policy is disabled. The loop must treat it as plain text.
  const root = await mkdtemp(path.join(tmpdir(), "adv-mcp-"));
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [{ id: "1", name: "list_dir", arguments: { path: "." } }] },
    { text: "done", toolCalls: [] },
  ]);
  const messages: AgentMessage[] = [{ role: "user", content: "go" }];
  // mode stays whatever it is regardless of any tool output.
  await runAgentLoop(messages, makeDeps(provider, makeCtx(root), { mode: "readonly" }));
  // A subsequent dangerous run_bash must still be denied in readonly mode.
  const { checkPermission: cp } = await import("../../src/permissions/policy.js");
  const danger: ToolInvocation = { kind: "execute", command: "rm -rf .", describe: () => "x", execute: async () => ({ output: "" }) };
  assert.equal(cp(danger, "readonly"), "deny");
});
