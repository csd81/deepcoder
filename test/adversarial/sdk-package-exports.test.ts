/**
 * Phase 10B slice 5 — public package exports + docs.
 *
 * Exposes the SDK/server surface through stable public barrels and a package.json
 * `exports` map, and documents embedding in the README. No new runtime behavior —
 * just the public API boundary and docs.
 *
 * Deliverables (each tagged [10B5-*]):
 *   [10B5-barrel]  src/sdk/index.ts re-exports the public SDK surface
 *                  (DeepcoderClient + the event layer)
 *   [10B5-server]  src/server/index.ts re-exports the server surface
 *                  (createStdioServer + the httpCore policy helpers)
 *   [10B5-exports] package.json has an `exports` map for "." and "./server"
 *   [10B5-docs]    README documents the SDK with a DeepcoderClient embedding example
 *
 * RED ANCHOR: imports from src/sdk/index.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as sdk from "../../src/sdk/index.js";
import * as server from "../../src/server/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("[10B5-barrel] src/sdk/index.ts re-exports the public SDK surface", () => {
  assert.equal(typeof sdk.DeepcoderClient, "function", "DeepcoderClient is exported");
  assert.equal(typeof sdk.redactEvent, "function", "redactEvent is re-exported from the event layer");
  assert.equal(typeof sdk.EventBuffer, "function", "EventBuffer is re-exported");
});

test("[10B5-exports] package.json exports map covers '.' and './server'", () => {
  const pkg = JSON.parse(readFileSync(repoRoot + "package.json", "utf8"));
  assert.ok(pkg.exports, "package.json has an exports field");
  assert.ok(pkg.exports["."], "exports has a root '.' entry");
  assert.ok(pkg.exports["./server"], "exports has a './server' entry");
});

test("[10B5-server] src/server/index.ts re-exports the server surface", () => {
  assert.equal(typeof server.createStdioServer, "function", "createStdioServer is exported");
  assert.equal(typeof server.requireServerToken, "function", "requireServerToken is exported");
  assert.equal(typeof server.resolveBindHost, "function", "resolveBindHost is exported");
  assert.equal(typeof server.checkAuth, "function", "checkAuth is exported");
  assert.equal(typeof server.withinBodyLimit, "function", "withinBodyLimit is exported");
  assert.equal(typeof server.DEFAULT_MAX_BODY_BYTES, "number", "DEFAULT_MAX_BODY_BYTES is exported");
  assert.equal(typeof server.RunRegistry, "function", "RunRegistry is exported");
  assert.equal(typeof server.formatSse, "function", "formatSse is exported");
  assert.equal(typeof server.SseReplayBuffer, "function", "SseReplayBuffer is exported");
});

test("[10B5-docs] README.md contains SDK section mentioning DeepcoderClient", () => {
  const readme = readFileSync(repoRoot + "README.md", "utf8");
  assert.ok(readme.includes("## SDK / Embedding"), "README has an SDK / Embedding section");
  assert.ok(readme.includes("DeepcoderClient"), "README mentions DeepcoderClient in the SDK section");
});
