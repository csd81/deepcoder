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
  const keys = ["DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_CONTAIN", "DEEPCODER_SANDBOX"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const KEY = { DEEPCODER_PROVIDER: "openrouter", DEEPCODER_API_KEY: "k" };

test("default: containment ON → sandbox is fail-closed bubblewrap/no-mounts", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(c.containment.enabled, true);
    assert.equal(c.sandbox.mode, "bubblewrap");
    assert.equal(c.sandbox.fallback, "fail");
    assert.deepEqual(c.sandbox.extraMounts, []);
  });
});

test("--no-contain (CLI false) disables it → sandbox untouched (fast)", () => {
  withEnv(KEY, () => {
    const c = loadConfig({ workspaceRoot: "/tmp", containment: { enabled: false } });
    assert.equal(c.containment.enabled, false);
    assert.equal(c.sandbox.mode, "fast");
  });
});

test("env DEEPCODER_CONTAIN=0 disables the default", () => {
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "0" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).containment.enabled, false);
  });
});

test("env DEEPCODER_CONTAIN=1 enables it", () => {
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "1" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).containment.enabled, true);
  });
});

test("CLI override wins over env (flag false beats DEEPCODER_CONTAIN=1)", () => {
  withEnv({ ...KEY, DEEPCODER_CONTAIN: "1" }, () => {
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
