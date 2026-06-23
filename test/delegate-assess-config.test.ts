import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";

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

test("delegate.assess defaults to ENABLED (the nudge is on by default)", () => {
  withEnv({ DEEPCODER_DELEGATE_ASSESS: undefined }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.assess.enabled, true);
  });
});

test("DEEPCODER_DELEGATE_ASSESS=0 disables the per-prompt nudge", () => {
  withEnv({ DEEPCODER_DELEGATE_ASSESS: "0" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.assess.enabled, false);
  });
  withEnv({ DEEPCODER_DELEGATE_ASSESS: "false" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.assess.enabled, false);
  });
});

test("DEEPCODER_DELEGATE_ASSESS=1 keeps it on; unrelated values leave default on", () => {
  withEnv({ DEEPCODER_DELEGATE_ASSESS: "1" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.assess.enabled, true);
  });
});
