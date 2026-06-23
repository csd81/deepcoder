import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/agent/systemPrompt.js";
import { PROFILES } from "../src/subagents/profiles.js";

const prompt = () => buildSystemPrompt({ workspaceRoot: "/ws", mode: "auto" });

test("[system-prompt] standing Delegation guidance is present", () => {
  const p = prompt();
  assert.match(p, /## Delegation/);
  assert.match(p, /delegate/i);
  assert.match(p, /read-only/i);
});

test("[system-prompt] the 3 merged behavioral rules are present", () => {
  const p = prompt();
  assert.match(p, /re-export|backward-compat|compatibility/i, "no-compat-hacks rule");
  assert.match(p, /prefer editing|edit.*existing/i, "prefer-editing rule");
  assert.match(p, /tests fail|truthful|did not verify|unverified/i, "truthful-reporting rule");
});

test("[anti-recursion] no subagent profile can call the delegate tool", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    assert.ok(
      !profile.allowedTools.includes("delegate"),
      `profile ${name} must not be allowed to delegate (prevents recursion)`,
    );
  }
});
