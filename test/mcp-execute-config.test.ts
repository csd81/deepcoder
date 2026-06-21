import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";
import { checkPermission } from "../src/permissions/policy.js";
import type { ToolInvocation } from "../src/tools/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const mcpExecuteInv: ToolInvocation = {
  kind: "execute",
  source: "mcp",
  describe: () => "mcp execute tool",
  execute: async () => ({ output: "" }),
};

test("mcpExecuteEnabled defaults to false (execute-mode MCP tools stay denied)", () => {
  withEnv({ DEEPCODER_MCP_EXECUTE: undefined }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.mcpExecuteEnabled, false);
    assert.equal(checkPermission(mcpExecuteInv, "auto", { mcpExecuteEnabled: cfg.mcpExecuteEnabled }), "deny");
  });
});

test("DEEPCODER_MCP_EXECUTE=1 opts in; the policy still gates (ask, never auto-allow without a command)", () => {
  withEnv({ DEEPCODER_MCP_EXECUTE: "1" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.mcpExecuteEnabled, true);
    // Enabled only lifts the blanket deny — a command-less MCP execute tool still
    // requires approval, and readonly mode still refuses it.
    assert.equal(checkPermission(mcpExecuteInv, "ask", { mcpExecuteEnabled: cfg.mcpExecuteEnabled }), "ask");
    assert.equal(checkPermission(mcpExecuteInv, "readonly", { mcpExecuteEnabled: cfg.mcpExecuteEnabled }), "deny");
  });
});

test("DEEPCODER_MCP_EXECUTE=true is accepted; other values stay off (fail-closed)", () => {
  withEnv({ DEEPCODER_MCP_EXECUTE: "true" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).mcpExecuteEnabled, true);
  });
  withEnv({ DEEPCODER_MCP_EXECUTE: "yes-please" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).mcpExecuteEnabled, false);
  });
  withEnv({ DEEPCODER_MCP_EXECUTE: "0" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).mcpExecuteEnabled, false);
  });
});
