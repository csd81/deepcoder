/**
 * Phase 10S — containment config resolution through loadConfig.
 * Precedence: CLI override > env (DEEPCODER_CONTAIN) > file > default-off.
 * When enabled, the effective sandbox becomes fail-closed workspace-only and
 * WINS over an explicit --sandbox mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_CONTAIN", "DEEPCODER_SANDBOX", "DEEPCODER_MCP_EXECUTE", "DEEPCODER_INTERACTIVE_SHELL", "DEEPCODER_ALLOW_UNCONTAINED"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const KEY = { DEEPCODER_PROVIDER: "deepseek", DEEPCODER_API_KEY: "k" };

test("default: containment ON → sandbox is fail-closed bubblewrap/no-mounts", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(c.containment.enabled, true);
    assert.equal(c.sandbox.mode, "bubblewrap");
    assert.equal(c.sandbox.fallback, "fail");
    assert.deepEqual(c.sandbox.extraMounts, []);
  });
});

test("QUARANTINE: --no-contain is IGNORED by default (containment stays ON)", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", containment: { enabled: false } });
    assert.equal(c.containment.enabled, true); // disabling is quarantined
    assert.equal(c.sandbox.mode, "bubblewrap");
  });
});

test("QUARANTINE: env DEEPCODER_CONTAIN=0 is IGNORED by default", () => {
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "0" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).containment.enabled, true);
  });
});

test("DEEPCODER_ALLOW_UNCONTAINED=1 re-enables --no-contain (the bypass hatch)", () => {
  withEnv({ ...KEY, DEEPCODER_ALLOW_UNCONTAINED: "1" }, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", containment: { enabled: false } });
    assert.equal(c.containment.enabled, false);
    assert.equal(c.sandbox.mode, "fast");
  });
});

test("env DEEPCODER_CONTAIN=1 enables it", () => {
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "1" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).containment.enabled, true);
  });
});

test("CLI override wins over env (flag false beats DEEPCODER_CONTAIN=1) — only with the bypass hatch open", () => {
  // The CLI-beats-env precedence for DISABLING containment only matters when the
  // quarantine bypass is open; otherwise --no-contain is ignored (covered above).
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "1", DEEPCODER_ALLOW_UNCONTAINED: "1" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp", containment: { enabled: false } }).containment.enabled, false);
  });
});

test("containment WINS over an explicit --sandbox off", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", sandbox: { mode: "off" }, containment: { enabled: true } });
    assert.equal(c.sandbox.mode, "bubblewrap");
    assert.equal(c.sandbox.fallback, "fail");
  });
});

// ── Phase 10T: yolo couples containment ON + escape hatches OFF ──
test("yolo forces containment ON + bubblewrap + escape hatches OFF", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", approvalMode: "yolo" });
    assert.equal(c.approvalMode, "yolo");
    assert.equal(c.containment.enabled, true);
    assert.equal(c.sandbox.mode, "bubblewrap");
    assert.equal(c.mcpExecuteEnabled, false);
    assert.equal(c.interactiveShell, false);
  });
});

test("yolo + --no-contain → containment still ON (yolo wins)", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", approvalMode: "yolo", containment: { enabled: false } });
    assert.equal(c.containment.enabled, true);
  });
});

test("yolo forces escape hatches off even when env tries to enable them", () => {
  withEnv({ ...KEY, DEEPCODER_MCP_EXECUTE: "1", DEEPCODER_INTERACTIVE_SHELL: "1" }, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", approvalMode: "yolo" });
    assert.equal(c.mcpExecuteEnabled, false);
    assert.equal(c.interactiveShell, false);
  });
});

test("without yolo, env CAN enable the escape hatches (sanity)", () => {
  withEnv({ ...KEY, DEEPCODER_MCP_EXECUTE: "1", DEEPCODER_INTERACTIVE_SHELL: "1" }, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", containment: { enabled: false } });
    assert.equal(c.mcpExecuteEnabled, true);
    assert.equal(c.interactiveShell, true);
  });
});
