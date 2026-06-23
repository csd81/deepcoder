import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientOptions, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from "../src/providers/openaiCompatible.js";

// Regression for the audit HIGH finding: the provider client was built with NO
// timeout/maxRetries → SDK 10-min default → a hung connection blocks the whole
// agent loop. resolveClientOptions must always produce a finite, bounded timeout.

test("[provider] default timeout + maxRetries are finite and bounded", () => {
  const o = resolveClientOptions({ apiKey: "k", baseUrl: "https://x", label: "L" });
  assert.equal(o.timeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(o.maxRetries, DEFAULT_MAX_RETRIES);
  assert.ok(Number.isFinite(o.timeout) && o.timeout > 0);
});

test("[provider] explicit timeoutMs/maxRetries pass through", () => {
  const o = resolveClientOptions({ apiKey: "k", baseUrl: "https://x", label: "L", timeoutMs: 30000, maxRetries: 5 });
  assert.equal(o.timeout, 30000);
  assert.equal(o.maxRetries, 5);
});

test("[provider] non-positive / NaN timeout falls back to the default (never unbounded)", () => {
  assert.equal(resolveClientOptions({ apiKey: "k", baseUrl: "x", label: "L", timeoutMs: 0 }).timeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveClientOptions({ apiKey: "k", baseUrl: "x", label: "L", timeoutMs: -5 }).timeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveClientOptions({ apiKey: "k", baseUrl: "x", label: "L", timeoutMs: NaN }).timeout, DEFAULT_REQUEST_TIMEOUT_MS);
});

test("[provider] apiKey/baseURL/headers pass through", () => {
  const o = resolveClientOptions({ apiKey: "secret", baseUrl: "https://api.x", label: "L", defaultHeaders: { "X-A": "1" } });
  assert.equal(o.apiKey, "secret");
  assert.equal(o.baseURL, "https://api.x");
  assert.deepEqual(o.defaultHeaders, { "X-A": "1" });
});
