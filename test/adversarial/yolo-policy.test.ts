/**
 * Phase 10T — `--yolo` permission policy.
 * yolo auto-approves everything CONTAINED (mutate + execute, incl. deny-classified)
 * but never resurrects an execute-mode MCP tool (the uncontained escape hatch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPermission } from "../../src/permissions/policy.js";
import type { ToolInvocation } from "../../src/tools/types.js";

const inv = (over: Partial<ToolInvocation>): ToolInvocation =>
  ({ kind: "execute", describe: () => "", execute: async () => ({ output: "" }), ...over } as ToolInvocation);

test("yolo allows a mutating tool (edit/write)", () => {
  assert.equal(checkPermission(inv({ kind: "mutate" }), "yolo"), "allow");
});

test("yolo allows a deny-classified execute command (sandbox is the net)", () => {
  assert.equal(checkPermission(inv({ kind: "execute", command: "rm -rf /" }), "yolo"), "allow");
  assert.equal(checkPermission(inv({ kind: "execute", command: "sudo reboot" }), "yolo"), "allow");
});

test("yolo allows ask/allow execute commands", () => {
  assert.equal(checkPermission(inv({ kind: "execute", command: "curl example.com" }), "yolo"), "allow");
  assert.equal(checkPermission(inv({ kind: "execute", command: "ls" }), "yolo"), "allow");
});

test("yolo allows read-only and session tools", () => {
  assert.equal(checkPermission(inv({ kind: "read-only" }), "yolo"), "allow");
  assert.equal(checkPermission(inv({ kind: "session" }), "yolo"), "allow");
});

test("yolo does NOT resurrect an execute-mode MCP tool when mcpExecuteEnabled is false", () => {
  const mcp = inv({ kind: "execute", source: "mcp", command: "anything" });
  assert.equal(checkPermission(mcp, "yolo", { mcpExecuteEnabled: false }), "deny");
  // only allowed if the operator separately enabled MCP execute
  assert.equal(checkPermission(mcp, "yolo", { mcpExecuteEnabled: true }), "allow");
});

test("non-yolo modes are unchanged (auto still prompts ask-tier, denies deny-tier)", () => {
  assert.equal(checkPermission(inv({ kind: "execute", command: "rm -rf /" }), "auto"), "deny");
  assert.equal(checkPermission(inv({ kind: "mutate" }), "ask"), "ask");
  assert.equal(checkPermission(inv({ kind: "mutate" }), "readonly"), "deny");
});
