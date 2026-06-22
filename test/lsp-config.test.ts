import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";

const base = { apiKey: "k", workspaceRoot: "/tmp" };

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("lsp is DEFAULT-OFF", () => {
  withEnv("DEEPCODER_LSP", undefined, () => {
    assert.equal(loadConfig({ ...base }).lsp.enabled, false);
  });
});

test("DEEPCODER_LSP=1 enables lsp", () => {
  withEnv("DEEPCODER_LSP", "1", () => {
    assert.equal(loadConfig({ ...base }).lsp.enabled, true);
  });
});

test("CLI/SDK override enables lsp regardless of env", () => {
  withEnv("DEEPCODER_LSP", undefined, () => {
    assert.equal(loadConfig({ ...base, lsp: { enabled: true } }).lsp.enabled, true);
  });
});
