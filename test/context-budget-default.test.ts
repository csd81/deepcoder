import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

const base = { apiKey: "k", workspaceRoot: "/tmp" };

test("DeepSeek (default provider) defaults to the full 1M context window", () => {
  withEnv({ DEEPCODER_PROVIDER: undefined, DEEPCODER_CONTEXT_BUDGET_TOKENS: undefined, DEEPCODER_COMPACT_AT: undefined }, () => {
    const c = loadConfig({ ...base });
    assert.equal(c.contextBudgetTokens, 1_000_000);
    assert.equal(c.compactAt, 0.95);
  });
});

test("non-DeepSeek providers keep the conservative 120K default", () => {
  // ollama: a non-deepseek provider that requires no API key (clean to load here).
  withEnv({ DEEPCODER_PROVIDER: "ollama", DEEPCODER_CONTEXT_BUDGET_TOKENS: undefined, DEEPCODER_COMPACT_AT: undefined }, () => {
    const c = loadConfig({ ...base });
    assert.equal(c.contextBudgetTokens, 120_000);
    assert.equal(c.compactAt, 0.8);
  });
});

test("env still overrides the provider-aware default", () => {
  withEnv({ DEEPCODER_PROVIDER: undefined, DEEPCODER_CONTEXT_BUDGET_TOKENS: "256000", DEEPCODER_COMPACT_AT: "0.7" }, () => {
    const c = loadConfig({ ...base });
    assert.equal(c.contextBudgetTokens, 256_000);
    assert.equal(c.compactAt, 0.7);
  });
});
