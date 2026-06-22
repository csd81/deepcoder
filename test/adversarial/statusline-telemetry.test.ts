/**
 * Phase 10C — status snapshot, statusline renderer, session telemetry, config.
 * No live model; the git lookup is injected so nothing shells out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusSnapshot, type StatusSnapshotInput } from "../../src/telemetry/statusSnapshot.js";
import { renderStatusline } from "../../src/telemetry/statusline.js";
import { createSessionTelemetry, recordUsage, recordModelCall, updateEstimatedCost } from "../../src/telemetry/sessionTelemetry.js";
import { estimateCost } from "../../src/providers/pricing.js";
import { loadConfig } from "../../src/config/config.js";
import type { CostEstimate } from "../../src/providers/pricing.js";

function input(over: Partial<StatusSnapshotInput> = {}): StatusSnapshotInput {
  return {
    provider: "deepseek", model: "deepseek-chat", mode: "ask", sandbox: "fast",
    sandboxNetwork: "off", workspaceIsolation: "off",
    usage: { promptTokens: 42000, completionTokens: 1100, totalTokens: 43100 },
    mcpWarnings: 0, activeSkills: 0, warnings: [],
    ...over,
  };
}
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("4. buildStatusSnapshot redacts warning text and never includes an API key", async () => {
  const snap = await buildStatusSnapshot(input({ warnings: ["leak api_key=sk-abc123def456ghi789xyz"] }));
  assert.doesNotMatch(JSON.stringify(snap), /sk-abc123def456ghi789xyz/, "the key must be redacted");
  assert.match(snap.warnings[0], /\*\*\*/);
});

test("5. buildStatusSnapshot survives a git lookup that throws (git omitted, no throw)", async () => {
  const snap = await buildStatusSnapshot(input({ gitLookup: async () => { throw new Error("git boom"); } }));
  assert.equal(snap.git, undefined, "git omitted on failure");
  assert.equal(snap.provider, "deepseek");
});

test("6. renderStatusline output is a single line under the byte cap", async () => {
  const snap = await buildStatusSnapshot(input({ warnings: ["w1", "w2"], cost: estimateCost(input().usage, { provider: "deepseek", model: "deepseek-chat" }) }));
  const line = renderStatusline(snap, { maxBytes: 80 });
  assert.doesNotMatch(line, /\n/, "single line");
  assert.ok(Buffer.byteLength(line, "utf8") <= 80, `under cap (was ${Buffer.byteLength(line, "utf8")})`);
});

test("7. renderStatusline omits cost when pricing is unknown (tokens only)", async () => {
  const unknownCost: CostEstimate = { inputUsd: 0, outputUsd: 0, totalUsd: 0, cachedInputUsd: 0, pricingKnown: false, rateLabel: "unknown" };
  const snap = await buildStatusSnapshot(input({ cost: unknownCost }));
  assert.doesNotMatch(renderStatusline(snap, { maxBytes: 200 }), /\$/, "no dollar cost shown when pricing unknown");
});

test("8. estimateCost distinguishes known vs unknown pricing (drives /cost)", () => {
  const u = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
  assert.equal(estimateCost(u, { provider: "deepseek", model: "deepseek-chat" }).pricingKnown, true);
  assert.equal(estimateCost(u, { provider: "x", model: "y" }).rateLabel, "unknown");
});

test("11. buildStatusSnapshot carries activeCheck / activeSolveAttempt when provided", async () => {
  const snap = await buildStatusSnapshot(input({ activeCheck: "phase", activeSolveAttempt: { index: 2, max: 3 } }));
  assert.equal(snap.activeCheck, "phase");
  assert.deepEqual(snap.activeSolveAttempt, { index: 2, max: 3 });
});

test("12. statusline is disabled via DEEPCODER_STATUSLINE=off (default on)", () => {
  withEnv({ DEEPCODER_STATUSLINE: "off" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).telemetry.statusline, false);
  });
  withEnv({ DEEPCODER_STATUSLINE: undefined }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).telemetry.statusline, true);
  });
});

test("telemetry: recordUsage/recordModelCall/updateEstimatedCost accumulate", () => {
  let t = createSessionTelemetry("deepseek", "deepseek-chat");
  t = recordUsage(t, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  t = recordUsage(t, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  t = recordModelCall(t);
  assert.equal(t.usage.totalTokens, 300);
  assert.equal(t.modelCalls, 1);
  t = updateEstimatedCost(t, estimateCost(t.usage, { provider: "deepseek", model: "deepseek-chat" }));
  assert.equal(t.estimatedCost?.pricingKnown, true);
});

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, loadSession, newSessionId } from "../../src/session/sessionStore.js";
import type { SessionSnapshot } from "../../src/session/sessionStore.js";

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    provider: "deepseek", baseUrl: "x", model: "deepseek-chat", mode: "ask",
    messages: [], todos: [], readTracker: new Set(), writeTracker: new Set(),
    pendingCheckpoint: [], reviews: [], briefs: [], activatedSkills: [], ...over,
  };
}

test("9. SessionTelemetry persists into a snapshot and resumes (round-trip)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tel-"));
  try {
    const id = newSessionId();
    const store = new SessionStore(root, id);
    let tel = createSessionTelemetry("deepseek", "deepseek-chat");
    tel = recordUsage(tel, { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 });
    tel = recordModelCall(tel);
    await store.save(snap({ telemetry: tel }));
    const loaded = await loadSession(root, id);
    assert.equal(loaded.telemetry?.usage.totalTokens, 1200);
    assert.equal(loaded.telemetry?.modelCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("10. an OLD session snapshot without telemetry loads successfully (defaults)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tel-"));
  try {
    const id = newSessionId();
    await mkdir(path.join(root, ".deepcoder", "sessions"), { recursive: true });
    // A pre-10C session file: no `telemetry` key.
    const old = { id, provider: "deepseek", baseUrl: "x", model: "deepseek-chat", mode: "ask", messages: [], todos: [], readTracker: [], writeTracker: [], pendingCheckpoint: [], reviews: [], briefs: [], activatedSkills: [], createdAt: "", updatedAt: "" };
    await writeFile(path.join(root, ".deepcoder", "sessions", `${id}.json`), JSON.stringify(old), "utf8");
    const loaded = await loadSession(root, id);
    assert.equal(loaded.telemetry, undefined, "missing telemetry loads as undefined, no throw");
    assert.equal(loaded.model, "deepseek-chat");
  } finally { await rm(root, { recursive: true, force: true }); }
});
