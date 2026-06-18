import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../../src/providers/factory.js";
import {
  createToolCallAccumulator,
  mapProviderError,
  OpenAICompatibleProvider,
} from "../../src/providers/openaiCompatible.js";
import { DeepSeekProvider } from "../../src/providers/deepseek.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { checkPermission } from "../../src/permissions/policy.js";
import type { Config } from "../../src/config/config.js";
import type { ToolInvocation } from "../../src/tools/types.js";

function cfg(over: Partial<Config>): Config {
  return {
    provider: "deepseek", apiKey: "k", baseUrl: "", model: "m", maxTurns: 20, approvalMode: "ask",
    contextBudgetTokens: 64000, compactAt: 0.8, workspaceRoot: "/tmp", mcpServers: {}, mcpExecuteEnabled: false,
    ...over,
  };
}

// --- Factory ---

test("factory builds a provider for each supported backend", () => {
  assert.ok(createProvider(cfg({ provider: "deepseek" })) instanceof OpenAICompatibleProvider);
  assert.ok(createProvider(cfg({ provider: "ollama", apiKey: "" })) instanceof OpenAICompatibleProvider); // no key needed
  assert.ok(createProvider(cfg({ provider: "openai-compatible", baseUrl: "https://x.example/v1" })) instanceof OpenAICompatibleProvider);
  assert.ok(createProvider(cfg({ provider: "qwen" })) instanceof OpenAICompatibleProvider); // DashScope preset
  assert.ok(createProvider(cfg({ provider: "anthropic" })) instanceof AnthropicProvider); // native adapter
});

test("openai-compatible without a base URL fails with a clear error", () => {
  assert.throws(() => createProvider(cfg({ provider: "openai-compatible", baseUrl: "" })), /requires a base URL/);
});

test("unknown provider is rejected", () => {
  assert.throws(() => createProvider(cfg({ provider: "totally-made-up" })), /Unknown provider/);
});

test("DeepSeekProvider preset still constructs (back-compat)", () => {
  assert.ok(new DeepSeekProvider({ apiKey: "k" }) instanceof OpenAICompatibleProvider);
});

// --- Streaming tool-call accumulation ---

test("accumulator handles name-before-args split across deltas", () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: "a", function: { name: "read_file" } });
  acc.push({ index: 0, function: { arguments: '{"pa' } });
  acc.push({ index: 0, function: { arguments: 'th":"x"}' } });
  const calls = acc.finalize();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: "a", name: "read_file", arguments: { path: "x" } });
});

test("duplicate index deltas MERGE into one call (no duplication)", () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: "a", function: { name: "grep", arguments: '{"pattern"' } });
  acc.push({ index: 0, function: { arguments: ':"x"}' } });
  const calls = acc.finalize();
  assert.equal(calls.length, 1, "same index must not produce two calls");
  assert.deepEqual(calls[0]!.arguments, { pattern: "x" });
});

test("multiple distinct indexes yield multiple calls in order", () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 1, id: "b", function: { name: "second", arguments: "{}" } });
  acc.push({ index: 0, id: "a", function: { name: "first", arguments: "{}" } });
  const calls = acc.finalize();
  assert.deepEqual(calls.map((c) => c.name), ["first", "second"]);
});

test("nameless / malformed-arg entries are dropped or default to empty args", () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: "x", function: { arguments: "{}" } }); // no name → dropped
  acc.push({ index: 1, id: "y", function: { name: "ok", arguments: "not json" } }); // bad args → {}
  const calls = acc.finalize();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: "y", name: "ok", arguments: {} });
});

// --- Error mapping (never leak the key) ---

test("mapProviderError produces readable errors and never includes the API key", () => {
  const key = "sk-SECRETKEY-shouldnotappear";
  for (const status of [401, 429, 400, 404]) {
    const e = mapProviderError({ status, message: `auth failed for ${key}` }, { label: "DeepSeek", model: "m" });
    assert.match(e.message, /DeepSeek/);
    assert.ok(!e.message.includes(key), `status ${status} must not leak the key`);
  }
});

// --- Permissions are provider-independent ---

test("a dangerous invocation is denied regardless of configured provider", () => {
  const danger: ToolInvocation = { kind: "execute", command: "rm -rf .", describe: () => "x", execute: async () => ({ output: "" }) };
  // checkPermission has no provider parameter — proving the policy can't vary by provider.
  assert.equal(checkPermission(danger, "auto"), "deny");
  assert.equal(checkPermission(danger, "ask"), "deny");
});
