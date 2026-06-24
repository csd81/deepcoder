import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";

// loadConfig reads process.env and requires an API key; provide a fake one (no
// network is touched) and save/restore every env var we mutate in finally.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, val] of Object.entries(vars)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fn();
  } finally {
    for (const [key, val] of Object.entries(prior)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

test("modelAuto defaults to true when DEEPCODER_MODEL_AUTO is unset", () => {
  withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL_AUTO: undefined }, () => {
    assert.equal(loadConfig().modelAuto, true);
  });
});

test("DEEPCODER_MODEL_AUTO falsy values disable modelAuto", () => {
  for (const raw of ["0", "false", "off", "no", "FALSE", "Off"]) {
    withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL_AUTO: raw }, () => {
      assert.equal(loadConfig().modelAuto, false, `expected false for "${raw}"`);
    });
  }
});

test("DEEPCODER_MODEL_AUTO truthy values enable modelAuto", () => {
  for (const raw of ["1", "true", "on", "yes", "TRUE", "On"]) {
    withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL_AUTO: raw }, () => {
      assert.equal(loadConfig().modelAuto, true, `expected true for "${raw}"`);
    });
  }
});

test("modelExplicit is false when no model is pinned (left at provider default)", () => {
  withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL: undefined, DEEPSEEK_MODEL: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.modelExplicit, false);
    // still resolves to a concrete (flash) default
    assert.equal(typeof cfg.model, "string");
    assert.ok(cfg.model.length > 0);
  });
});

test("modelExplicit is true when DEEPCODER_MODEL is set", () => {
  withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL: "deepseek-v4-pro" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.modelExplicit, true);
    assert.equal(cfg.model, "deepseek-v4-pro");
  });
});

test("modelExplicit is true when the model is overridden programmatically", () => {
  withEnv({ DEEPCODER_API_KEY: "test-key", DEEPCODER_MODEL: undefined }, () => {
    assert.equal(loadConfig({ model: "custom-model" }).modelExplicit, true);
  });
});
