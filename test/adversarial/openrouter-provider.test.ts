/**
 * Phase 10J — OpenRouter provider. Red seed: forces config + factory wiring.
 * The worker MUST keep these green AND add the full test set from
 * plans/providers/phase10j-openrouter-provider-plan.md (Tests section).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config.js";
import { createProvider } from "../../src/providers/factory.js";
import { OpenAICompatibleProvider } from "../../src/providers/openaiCompatible.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_BASE_URL", "DEEPCODER_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_MODEL", "DEEPSEEK_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("DEEPCODER_PROVIDER=openrouter resolves via OPENROUTER_API_KEY, default model, OpenAICompatible adapter", () => {
  withEnv({ DEEPCODER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-test-key" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.provider, "openrouter");
    assert.equal(cfg.apiKey, "or-test-key");
    assert.equal(cfg.model, "openrouter/auto");
    const p = createProvider(cfg);
    assert.ok(p instanceof OpenAICompatibleProvider);
  });
});

test("provider isolation: DEEPSEEK_API_KEY does not satisfy openrouter", () => {
  withEnv({ DEEPCODER_PROVIDER: "openrouter", DEEPSEEK_API_KEY: "ds-secret" }, () => {
    let key: string | undefined;
    try { key = loadConfig({ workspaceRoot: "/tmp" }).apiKey; } catch { key = "<threw>"; }
    assert.notEqual(key, "ds-secret", "a deepseek key must never satisfy openrouter");
  });
});
