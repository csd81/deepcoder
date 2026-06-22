/**
 * Fewer turns, same work: the agent loop counts ONE turn per model response but
 * executes every tool call in that response. So the system prompt must push the
 * model to batch independent tool calls into a single turn, and the default turn
 * cap is raised so longer tasks don't abort mid-flight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";
import { loadConfig } from "../../src/config/config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["DEEPCODER_PROVIDER", "DEEPCODER_API_KEY", "DEEPCODER_MAX_TURNS"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("system prompt tells the model to batch independent tool calls in one turn", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /parallel/i);
  // it must connect batching to independence (don't parallelize dependent calls)
  assert.match(p, /independent/i);
  // and it must mention issuing them in a single response/turn
  assert.match(p, /single (response|turn|message)/i);
});

test("default turn cap is raised from 20 to 40 (env still overrides)", () => {
  withEnv({ DEEPCODER_PROVIDER: "deepseek", DEEPCODER_API_KEY: "k" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).maxTurns, 40);
  });
  withEnv({ DEEPCODER_PROVIDER: "deepseek", DEEPCODER_API_KEY: "k", DEEPCODER_MAX_TURNS: "75" }, () => {
    assert.equal(loadConfig({ workspaceRoot: "/tmp" }).maxTurns, 75);
  });
});
