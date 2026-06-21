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

test("delegate.acceptanceFirst defaults to disabled", () => {
  withEnv({ DEEPCODER_DELEGATE_ACCEPTANCE_FIRST: undefined }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.delegate.acceptanceFirst.enabled, false);
  });
});

test("DEEPCODER_DELEGATE_ACCEPTANCE_FIRST=1 enables it; other values stay off (fail-closed)", () => {
  withEnv({ DEEPCODER_DELEGATE_ACCEPTANCE_FIRST: "1" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.acceptanceFirst.enabled, true);
  });
  withEnv({ DEEPCODER_DELEGATE_ACCEPTANCE_FIRST: "true" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.acceptanceFirst.enabled, true);
  });
  withEnv({ DEEPCODER_DELEGATE_ACCEPTANCE_FIRST: "nope" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).delegate.acceptanceFirst.enabled, false);
  });
});
