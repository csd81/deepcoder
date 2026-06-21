/**
 * Curated OpenRouter free-model list.
 *
 * Rule (user): on OpenRouter only ever use `:free` models, never paid/auto.
 * `openrouter/auto` can route to PAID models, so it must NOT be the default.
 *
 * The curated list holds only free models that were live-probed and returned a
 * real completion (2026-06-22). Saturated (429) and delisted (404) models are
 * excluded so the default path never "overuses" a rate-limited model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENROUTER_FREE_MODELS,
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_SATURATED_MODELS,
  isFreeModel,
} from "../../src/providers/openrouterFreeModels.js";
import { loadConfig } from "../../src/config/config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("every curated model is a :free model, non-empty, no duplicates", () => {
  assert.ok(OPENROUTER_FREE_MODELS.length > 0, "list must be non-empty");
  for (const m of OPENROUTER_FREE_MODELS) {
    assert.ok(m.endsWith(":free"), `${m} must end with :free`);
  }
  assert.equal(new Set(OPENROUTER_FREE_MODELS).size, OPENROUTER_FREE_MODELS.length, "no duplicates");
});

test("the curated list never contains openrouter/auto (auto can route to paid)", () => {
  assert.ok(!OPENROUTER_FREE_MODELS.includes("openrouter/auto"));
  assert.ok(!isFreeModel("openrouter/auto"));
});

test("default free model is the head of the curated list and is free", () => {
  assert.equal(OPENROUTER_DEFAULT_FREE_MODEL, OPENROUTER_FREE_MODELS[0]);
  assert.ok(isFreeModel(OPENROUTER_DEFAULT_FREE_MODEL));
});

test("no saturated/delisted model leaks into the curated working list", () => {
  assert.ok(OPENROUTER_SATURATED_MODELS.length > 0, "must document the excluded saturated models");
  for (const s of OPENROUTER_SATURATED_MODELS) {
    assert.ok(!OPENROUTER_FREE_MODELS.includes(s), `${s} is saturated and must be excluded`);
  }
});

test("isFreeModel recognizes the :free suffix only", () => {
  assert.ok(isFreeModel("openai/gpt-oss-20b:free"));
  assert.ok(!isFreeModel("openai/gpt-4o-mini"));
  assert.ok(!isFreeModel("qwen/qwen3-coder"));
});

test("WIRING: provider=openrouter with no model env defaults to a free model, never openrouter/auto", () => {
  withEnv({ DEEPCODER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-test-key" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.provider, "openrouter");
    assert.notEqual(cfg.model, "openrouter/auto");
    assert.ok(isFreeModel(cfg.model), `default model ${cfg.model} must be :free`);
    assert.equal(cfg.model, OPENROUTER_DEFAULT_FREE_MODEL);
  });
});

test("WIRING: an explicit DEEPCODER_MODEL still overrides the free default", () => {
  withEnv({ DEEPCODER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", DEEPCODER_MODEL: "openai/gpt-oss-120b:free" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.model, "openai/gpt-oss-120b:free");
  });
});
