/**
 * Phase 10C — session telemetry restoration on resume.
 *
 * Ensures that telemetry persisted via SessionStore.save is restored correctly
 * by loadSession. Pre-10C sessions (no telemetry field) load without error and
 * yield undefined telemetry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, loadSession } from "../../src/session/sessionStore.js";
import type { SessionTelemetry } from "../../src/telemetry/sessionTelemetry.js";

test("telemetry round-trips through save/load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-tlm-"));
  const id = "test-telemetry-roundtrip";

  const telemetry: SessionTelemetry = {
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T01:00:00.000Z",
    provider: "test-provider",
    model: "test-model",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    estimatedCost: { inputUsd: 0.003, outputUsd: 0.002, totalUsd: 0.005, pricingKnown: true, rateLabel: "test" },
    modelCalls: 5,
    toolCalls: 12,
    checkRuns: 3,
    warnings: [{ message: "test warning", at: "2025-01-01T00:30:00.000Z" }],
  };

  const store = new SessionStore(root, id);
  await store.save({
    provider: "test-provider",
    baseUrl: "",
    model: "test-model",
    mode: "auto",
    messages: [{ role: "user", content: "hello" }],
    todos: [],
    readTracker: new Set(),
    telemetry,
  });

  const loaded = await loadSession(root, id);
  assert.deepEqual(loaded.telemetry, telemetry);
});

test("pre-10C session (no telemetry) loads with undefined telemetry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-tlm2-"));
  const id = "test-no-telemetry";

  const store = new SessionStore(root, id);
  await store.save({
    provider: "test-provider",
    baseUrl: "",
    model: "test-model",
    mode: "auto",
    messages: [{ role: "user", content: "hello" }],
    todos: [],
    readTracker: new Set(),
    // telemetry deliberately omitted
  });

  const loaded = await loadSession(root, id);
  assert.equal(loaded.telemetry, undefined);
});
