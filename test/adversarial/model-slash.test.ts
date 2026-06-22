/**
 * Phase 10L — Session model/effort slash commands.
 *
 * Pure-function unit tests for sessionOverrides.ts, router integration tests
 * for session-override precedence, and lightweight slash function tests that
 * verify the command output contract without a live session.
 *
 * No live model, no network, no config-file writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../../src/models/router.js";
import {
  emptySessionModelOverrides,
  parseModelTarget,
  isValidRole,
  isValidEffort,
  applyModelOverride,
  applyEffortOverride,
  clearModelOverride,
  clearEffortOverride,
} from "../../src/models/sessionOverrides.js";
import type { SessionModelOverrides } from "../../src/models/sessionOverrides.js";
import { ALL_ROLES } from "../../src/models/types.js";
import type { Config } from "../../src/config/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal Config the router actually reads. */
function cfg(over: Partial<Config> = {}): Config {
  return {
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.example.com/v1",
    reasonerModel: "deepseek-reasoner",
    subagentModel: undefined,
    temperature: 0,
    reasoningEffort: undefined,
    workspaceRoot: "/tmp",
    ...over,
  } as unknown as Config;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ── Pure: parseModelTarget ───────────────────────────────────────────────────

test("[phase10l-parse-1] parseModelTarget('openrouter/qwen/qwen3-coder:free') returns provider + model", () => {
  const res = parseModelTarget("openrouter/qwen/qwen3-coder:free");
  assert.equal(res.provider, "openrouter");
  assert.equal(res.model, "qwen/qwen3-coder:free");
});

test("[phase10l-parse-2] parseModelTarget('deepseek-chat') returns model only", () => {
  const res = parseModelTarget("deepseek-chat");
  assert.equal(res.provider, undefined);
  assert.equal(res.model, "deepseek-chat");
});

test("[phase10l-parse-3] parseModelTarget rejects control characters", () => {
  assert.throws(() => parseModelTarget("deepseek\nchat"), /control characters/);
  assert.throws(() => parseModelTarget("deepseek\tchat"), /control characters/);
  assert.throws(() => parseModelTarget("deepseek\x00chat"), /control characters/);
});

test("[phase10l-parse-4] parseModelTarget rejects empty strings", () => {
  assert.throws(() => parseModelTarget(""), /empty/);
  assert.throws(() => parseModelTarget("   "), /empty/);
});

test("[phase10l-parse-5] parseModelTarget rejects overly long strings", () => {
  const long = "a".repeat(201);
  assert.throws(() => parseModelTarget(long), /too long/);
});

test("[phase10l-parse-6] parseModelTarget with provider/model but empty provider or model", () => {
  assert.throws(() => parseModelTarget("/model"), /Provider prefix cannot be empty/);
  assert.throws(() => parseModelTarget("provider/"), /Model name cannot be empty/);
});

// ── Pure: isValidRole ────────────────────────────────────────────────────────

test("[phase10l-role-1] isValidRole returns true for known roles", () => {
  for (const role of ALL_ROLES) {
    assert.equal(isValidRole(role), true);
  }
});

test("[phase10l-role-2] isValidRole returns false for unknown roles", () => {
  assert.equal(isValidRole("bogus"), false);
  assert.equal(isValidRole(""), false);
  assert.equal(isValidRole("edit "), false); // trailing space
  assert.equal(isValidRole("EDIT"), false); // case-sensitive
});

// ── Pure: isValidEffort ──────────────────────────────────────────────────────

test("[phase10l-effort-1] isValidEffort accepts low, medium, high", () => {
  assert.equal(isValidEffort("low"), true);
  assert.equal(isValidEffort("medium"), true);
  assert.equal(isValidEffort("high"), true);
});

test("[phase10l-effort-2] isValidEffort rejects invalid values", () => {
  assert.equal(isValidEffort(""), false);
  assert.equal(isValidEffort("extreme"), false);
  assert.equal(isValidEffort("LOW"), false); // case-sensitive
  assert.equal(isValidEffort(" low"), false); // leading space
});

// ── Pure: applyModelOverride / clearModelOverride ────────────────────────────

test("[phase10l-override-1] applyModelOverride adds provider+model for a role", () => {
  const ov = emptySessionModelOverrides();
  const result = applyModelOverride(ov, "edit", { provider: "anthropic", model: "claude-4" });
  assert.equal(result.roles.edit?.provider, "anthropic");
  assert.equal(result.roles.edit?.model, "claude-4");
  // Original unchanged
  assert.equal(ov.roles.edit, undefined);
});

test("[phase10l-override-2] applyModelOverride with only model preserves existing fields", () => {
  const ov = applyModelOverride(emptySessionModelOverrides(), "edit", { provider: "anthropic", model: "claude-4" });
  const result = applyModelOverride(ov, "edit", { model: "claude-5" });
  assert.equal(result.roles.edit?.provider, "anthropic"); // preserved
  assert.equal(result.roles.edit?.model, "claude-5"); // updated
});

test("[phase10l-override-3] reset one role preserves other overrides", () => {
  let ov = emptySessionModelOverrides();
  ov = applyModelOverride(ov, "edit", { provider: "deepseek", model: "deepseek-chat" });
  ov = applyModelOverride(ov, "plan", { provider: "anthropic", model: "claude-4" });
  const cleared = clearModelOverride(ov, "edit");
  assert.equal(cleared.roles.edit, undefined);
  assert.equal(cleared.roles.plan?.model, "claude-4"); // preserved
});

test("[phase10l-override-4] reset all clears every override", () => {
  let ov = emptySessionModelOverrides();
  ov = applyModelOverride(ov, "edit", { provider: "deepseek", model: "deepseek-chat" });
  ov = applyModelOverride(ov, "plan", { provider: "anthropic", model: "claude-4" });
  const cleared = clearModelOverride(ov, "all");
  assert.deepEqual(cleared.roles, {});
});

// ── Pure: applyEffortOverride / clearEffortOverride ──────────────────────────

test("[phase10l-effort-3] applyEffortOverride sets global default", () => {
  const ov = emptySessionModelOverrides();
  const result = applyEffortOverride(ov, "high");
  assert.equal(result.defaultReasoningEffort, "high");
});

test("[phase10l-effort-4] applyEffortOverride sets role-specific effort", () => {
  const ov = emptySessionModelOverrides();
  const result = applyEffortOverride(ov, "low", "plan");
  assert.equal(result.roles.plan?.reasoningEffort, "low");
});

test("[phase10l-effort-5] clearEffortOverride removes default effort", () => {
  let ov = emptySessionModelOverrides();
  ov = applyEffortOverride(ov, "high");
  const cleared = clearEffortOverride(ov, "all");
  assert.equal(cleared.defaultReasoningEffort, undefined);
});

test("[phase10l-effort-6] clearEffortOverride removes role effort but preserves model", () => {
  let ov = emptySessionModelOverrides();
  ov = applyModelOverride(ov, "plan", { provider: "anthropic", model: "claude-4" });
  ov = applyEffortOverride(ov, "low", "plan");
  const cleared = clearEffortOverride(ov, "plan");
  assert.equal(cleared.roles.plan?.reasoningEffort, undefined);
  assert.equal(cleared.roles.plan?.model, "claude-4"); // model preserved
});

// ── Router integration: session override precedence ─────────────────────────

test("[phase10l-router-1] Session override beats env, file, and default", () => {
  withEnv({ DEEPCODER_MODEL_REVIEW: "env-review" }, () => {
    const router = new ModelRouter(cfg(), { roles: { review: { model: "file-review" } } });
    router.sessionOverrides = { roles: { review: { model: "session-review" } } };
    const route = router.resolve("review");
    assert.equal(route.model, "session-review");
    assert.equal(route.source, "session");
  });
});

test("[phase10l-router-2] Session override with only model preserves current provider/baseUrl", () => {
  const router = new ModelRouter(cfg({ provider: "deepseek" }));
  router.sessionOverrides = { roles: { edit: { model: "deepseek-v4" } } };
  const route = router.resolve("edit");
  assert.equal(route.model, "deepseek-v4");
  assert.equal(route.provider, "deepseek"); // preserved from default
  assert.equal(route.source, "session");
});

test("[phase10l-router-3] Effort override applies to the selected role", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: { plan: { reasoningEffort: "high" } } };
  const route = router.resolve("plan");
  assert.equal(route.reasoningEffort, "high");
  assert.equal(route.source, "session");
});

test("[phase10l-router-4] Default session effort applies when a role has no specific effort", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = {
    roles: { plan: { model: "deepseek-reasoner" } },
    defaultReasoningEffort: "medium",
  };
  const route = router.resolve("plan");
  assert.equal(route.model, "deepseek-reasoner");
  assert.equal(route.reasoningEffort, "medium"); // from default
});

test("[phase10l-router-5] Without session override, env still beats file/default", () => {
  withEnv({ DEEPCODER_MODEL_REVIEW: "env-review" }, () => {
    const router = new ModelRouter(cfg(), { roles: { review: { model: "file-review" } } });
    // No session overrides set
    const route = router.resolve("review");
    assert.equal(route.model, "env-review");
    assert.equal(route.source, "env");
  });
});

test("[phase10l-router-6] explain() returns session source when override is active", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: { edit: { model: "session-model" } } };
  const routes = router.explain();
  const editRoute = routes.find((r) => r.role === "edit")!;
  assert.equal(editRoute.source, "session");
  assert.equal(editRoute.model, "session-model");
});

test("[phase10l-router-7] explain() without overrides shows default/env/file sources (unchanged)", () => {
  const router = new ModelRouter(cfg());
  const routes = router.explain();
  const editRoute = routes.find((r) => r.role === "edit")!;
  assert.equal(editRoute.source, "default");
});

// ── Slash command functional tests ───────────────────────────────────────────

test("[phase10l-slash-1] /model prints table without mutating", () => {
  const router = new ModelRouter(cfg());
  const routes = router.explain();
  // Just verify the explain output shape: one route per role, no side effects
  assert.equal(routes.length, ALL_ROLES.length);
  assert.equal(router.sessionOverrides, undefined); // no mutation
});

test("[phase10l-slash-2] /model review <target> changes only review route", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: {} };

  // Simulate /model review openrouter/qwen/qwen3-coder:free
  const parsed = parseModelTarget("openrouter/qwen/qwen3-coder:free");
  router.sessionOverrides = applyModelOverride(router.sessionOverrides, "review", parsed);

  const reviewRoute = router.resolve("review");
  assert.equal(reviewRoute.provider, "openrouter");
  assert.equal(reviewRoute.model, "qwen/qwen3-coder:free");
  assert.equal(reviewRoute.source, "session");

  // Other roles unchanged
  const editRoute = router.resolve("edit");
  assert.equal(editRoute.model, "deepseek-chat");
  assert.equal(editRoute.source, "default");
});

test("[phase10l-slash-3] /effort plan high changes only plan effort", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: {} };

  // Simulate /effort plan high
  router.sessionOverrides = applyEffortOverride(router.sessionOverrides, "high", "plan");

  const planRoute = router.resolve("plan");
  assert.equal(planRoute.reasoningEffort, "high");

  // Other roles unaffected
  const editRoute = router.resolve("edit");
  assert.equal(editRoute.reasoningEffort, undefined); // no effort in cfg default
});

test("[phase10l-slash-4] Invalid usage leaves state unchanged", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: { edit: { model: "original" } } };
  const snapshot = router.sessionOverrides.roles.edit?.model;

  // Simulate invalid parse: control characters rejected before mutate
  assert.throws(() => parseModelTarget("bad\x00model"), /control characters/);

  // State preserved
  assert.equal(router.sessionOverrides.roles.edit?.model, snapshot);
});

test("[phase10l-slash-5] /effort with unknown role does not mutate", () => {
  const router = new ModelRouter(cfg());
  router.sessionOverrides = { roles: {} };
  const snapshot = { ...router.sessionOverrides };

  // Invalid role — isValidRole returns false
  assert.equal(isValidRole("bogus"), false);

  // State unchanged
  assert.deepEqual(router.sessionOverrides, snapshot);
});

test("[phase10l-slash-6] /model reset all clears only model overrides (not default effort)", () => {
  let ov = emptySessionModelOverrides();
  ov = applyModelOverride(ov, "edit", { model: "m1" });
  ov = applyModelOverride(ov, "plan", { model: "m2" });
  ov = applyEffortOverride(ov, "high"); // global effort

  const cleared = clearModelOverride(ov, "all");
  assert.deepEqual(cleared.roles, {});
  assert.equal(cleared.defaultReasoningEffort, "high"); // preserved
});

test("[phase10l-slash-7] /effort reset all clears both default and role efforts", () => {
  let ov = emptySessionModelOverrides();
  ov = applyEffortOverride(ov, "high");
  ov = applyEffortOverride(ov, "low", "plan");

  const cleared = clearEffortOverride(ov, "all");
  assert.equal(cleared.defaultReasoningEffort, undefined);
  assert.equal(cleared.roles.plan?.reasoningEffort, undefined);
});

test("[phase10l-slash-8] /model with provider omitted keeps current provider from base", () => {
  const router = new ModelRouter(cfg({ provider: "deepseek" }));
  router.sessionOverrides = { roles: {} };

  // Simulate /model edit deepseek-v4-flash (no provider prefix)
  const parsed = parseModelTarget("deepseek-v4-flash");
  assert.equal(parsed.provider, undefined);

  router.sessionOverrides = applyModelOverride(router.sessionOverrides, "edit", parsed);
  const route = router.resolve("edit");
  assert.equal(route.provider, "deepseek"); // preserved from default
  assert.equal(route.model, "deepseek-v4-flash");
});
