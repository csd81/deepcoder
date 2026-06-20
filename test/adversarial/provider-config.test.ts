import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { redactSecrets, mapProviderError } from "../../src/providers/openaiCompatible.js";
import { SessionStore, newSessionId, loadSession } from "../../src/session/sessionStore.js";

/** Run a function with a patched process.env, always restored afterwards. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  // Clear all provider-related vars first for a clean slate.
  for (const k of [
    "DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_BASE_URL", "DEEPCODER_MODEL", "DEEPCODER_REASONER_MODEL",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "GEMINI_API_KEY", "GEMINI_BASE_URL", "GEMINI_MODEL",
    "QWEN_API_KEY", "ANTHROPIC_API_KEY",
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("malformed numeric env vars fall back to defaults (no NaN)", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-x", DEEPCODER_COMPACT_AT: "abc", DEEPCODER_MAX_TURNS: "", DEEPCODER_CONTEXT_BUDGET_TOKENS: "oops" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.compactAt, 0.8);
    assert.equal(cfg.maxTurns, 20);
    assert.equal(cfg.contextBudgetTokens, 64000);
  });
});

// --- F1: DeepSeek aliases must not leak into other providers ---

test("ollama does not inherit DEEPSEEK_BASE_URL (no silent DeepSeek calls)", () => {
  withEnv({ DEEPCODER_PROVIDER: "ollama", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "sk-deepseek" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.notEqual(cfg.baseUrl, "https://api.deepseek.com", "DeepSeek base URL must not leak into ollama");
    assert.equal(cfg.baseUrl, ""); // factory then applies the local Ollama default
  });
});

test("openai-compatible is not satisfied by a leftover DEEPSEEK_BASE_URL", () => {
  withEnv({ DEEPCODER_PROVIDER: "openai-compatible", DEEPCODER_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.baseUrl, "", "the DeepSeek alias must not satisfy the required base URL");
  });
});

test("deepseek still honours DEEPSEEK_* aliases (back-compat)", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-x", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_MODEL: "deepseek-chat" }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.provider, "deepseek");
    assert.equal(cfg.baseUrl, "https://api.deepseek.com");
    assert.equal(cfg.apiKey, "sk-x");
  });
});

// --- Per-provider env prefixes: keep multiple providers' keys in .env at once,
//     switch with DEEPCODER_PROVIDER, no commenting required. ---

test("openai-compatible resolves OPENAI_* vars for its own prefix", () => {
  withEnv({
    DEEPCODER_PROVIDER: "openai-compatible",
    OPENAI_API_KEY: "sk-openai",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL: "gpt-4o-mini",
  }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.apiKey, "sk-openai");
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
    assert.equal(cfg.model, "gpt-4o-mini");
  });
});

test("gemini resolves GEMINI_* vars for its own prefix", () => {
  withEnv({
    DEEPCODER_PROVIDER: "gemini",
    GEMINI_API_KEY: "g-key",
    GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
  }, () => {
    const cfg = loadConfig({ workspaceRoot: "/tmp" });
    assert.equal(cfg.apiKey, "g-key");
    assert.equal(cfg.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(cfg.model, "gemini-2.0-flash"); // provider default
  });
});

test("with BOTH providers' keys set, DEEPCODER_PROVIDER selects which one is used (no commenting)", () => {
  const both = {
    DEEPSEEK_API_KEY: "sk-deepseek",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    OPENAI_API_KEY: "sk-openai",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  };
  withEnv({ ...both, DEEPCODER_PROVIDER: "deepseek" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).apiKey, "sk-deepseek");
  });
  withEnv({ ...both, DEEPCODER_PROVIDER: "openai-compatible" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).apiKey, "sk-openai");
  });
});

test("a provider does NOT read another provider's key (deepseek is not satisfied by OPENAI_API_KEY)", () => {
  withEnv({ DEEPCODER_PROVIDER: "deepseek", OPENAI_API_KEY: "sk-openai" }, () => {
    assert.throws(() => loadConfig({ workspaceRoot: "/tmp" }), /API key/);
  });
});

test("an explicit DEEPCODER_API_KEY still overrides the per-provider key", () => {
  withEnv({ DEEPCODER_PROVIDER: "openai-compatible", DEEPCODER_API_KEY: "explicit", OPENAI_API_KEY: "sk-openai" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).apiKey, "explicit");
  });
});

// --- F5: unknown provider reported clearly, not masked by the key check ---

test("an unknown provider errors as unknown even with no API key", () => {
  withEnv({ DEEPCODER_PROVIDER: "typo-provider" }, () => {
    assert.throws(() => loadConfig({ workspaceRoot: "/tmp" }), /Unknown provider/);
  });
});

// --- F3: secret redaction in error text ---

test("redactSecrets strips keys, bearer tokens, api_key params, and url query keys", () => {
  const dirty = "failed: Authorization: Bearer sk-ABCDEF123456 and ?api_key=sk-ZZZ999 and api_key=plainsecret";
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes("sk-ABCDEF123456"));
  assert.ok(!clean.includes("sk-ZZZ999"));
  assert.ok(!clean.includes("plainsecret"));
});

test("mapProviderError default branch redacts a key embedded in the SDK message", () => {
  const key = "sk-LEAKVIANETWORKERROR0001";
  const e = mapProviderError({ message: `connect failed using key ${key}` }, { label: "Ollama", model: "m" });
  assert.ok(!e.message.includes(key), "default-branch error must not leak the key");
  assert.match(e.message, /Ollama request failed/);
});

// --- F2: provider metadata persisted; old sessions (no provider) still load ---

test("session store persists provider and baseUrl", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-provmeta-"));
  const id = newSessionId();
  await new SessionStore(root, id).save({
    provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1",
    mode: "ask", messages: [], todos: [], readTracker: new Set(),
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.provider, "ollama");
  assert.equal(loaded.baseUrl, "http://localhost:11434/v1");
  assert.equal(loaded.model, "llama3.1");
});

test("a legacy session without provider metadata still loads (undefined provider)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-legacy-"));
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  const id = "legacy";
  await writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, model: "deepseek-chat", mode: "ask", messages: [], todos: [], readTracker: [], createdAt: "", updatedAt: "" }),
    "utf8",
  );
  const loaded = await loadSession(root, id);
  assert.equal(loaded.provider, undefined);
  assert.equal(loaded.model, "deepseek-chat");
});
