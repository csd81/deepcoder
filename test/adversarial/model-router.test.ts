/**
 * Phase 10F — model/task router. SEED grew into the full suite: the router
 * resolves task ROLES to provider/model with default-preserving behavior, env/
 * file precedence, fallback validation, and no secret leakage. No live model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRouter, hasFallbackCycle } from "../../src/models/router.js";
import { READONLY_ROLES, ALL_ROLES } from "../../src/models/types.js";
import { loadConfig } from "../../src/config/config.js";
import { loadFileConfig } from "../../src/config/fileConfig.js";
import { reviewer, researcher, testTriage, explorer } from "../../src/subagents/profiles.js";
import type { Config } from "../../src/config/config.js";
import type { ModelsFileConfig } from "../../src/models/types.js";

/** Minimal Config the router actually reads (the rest is irrelevant to routing). */
function cfg(over: Partial<Config> = {}): Config {
  return {
    provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.example/v1",
    reasonerModel: "deepseek-reasoner", subagentModel: undefined, temperature: 0,
    ...over,
  } as unknown as Config;
}
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test("[router-edit-default] resolve('edit') returns the configured edit model (default-preserving)", () => {
  const c = loadConfig({ workspaceRoot: "/tmp" });
  const route = new ModelRouter(c).resolve("edit");
  assert.equal(route.role, "edit");
  assert.equal(route.model, c.model);
});

test("1. defaults preserve current edit/plan/subagent behavior", () => {
  const r = new ModelRouter(cfg({ subagentModel: "sub-model" }));
  assert.equal(r.resolve("edit").model, "deepseek-chat");
  assert.equal(r.resolve("edit").source, "default");
  assert.equal(r.resolve("plan").model, "deepseek-reasoner");        // reasonerModel
  assert.equal(r.resolve("review").model, "sub-model");              // subagentModel
  assert.equal(r.resolve("delegate").model, "deepseek-chat");        // → edit
  // plan with no reasonerModel falls back to edit model
  assert.equal(new ModelRouter(cfg({ reasonerModel: undefined })).resolve("plan").model, "deepseek-chat");
});

test("2. role-specific env override beats file and default", () => {
  withEnv({ DEEPCODER_MODEL_REVIEW: "env-review" }, () => {
    const r = new ModelRouter(cfg(), { roles: { review: { model: "file-review" } } });
    const route = r.resolve("review");
    assert.equal(route.model, "env-review");
    assert.equal(route.source, "env");
  });
});

test("3. file route provider/model parses and resolves", () => {
  const models: ModelsFileConfig = { roles: { review: { provider: "anthropic", model: "claude-x" } } };
  const route = new ModelRouter(cfg(), models).resolve("review");
  assert.equal(route.provider, "anthropic");
  assert.equal(route.model, "claude-x");
  assert.equal(route.source, "file");
});

test("4. unknown role in config warns and is skipped (config never blocks)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mr-"));
  try {
    await mkdir(path.join(dir, ".deepcoder"), { recursive: true });
    await writeFile(path.join(dir, ".deepcoder", "config.json"),
      JSON.stringify({ models: { roles: { bogusRole: { model: "x" } } } }), "utf8");
    const fc = loadFileConfig(dir);
    // The bogus role makes the whole models block invalid → skipped, not thrown.
    assert.ok(!fc.models?.roles || !("bogusRole" in (fc.models.roles as object)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("5. a fallback cycle is rejected (pure + at config load)", async () => {
  assert.equal(hasFallbackCycle({ plan: ["review"], review: ["plan"] }), true);
  assert.equal(hasFallbackCycle({ plan: ["edit"], review: ["edit"] }), false);
  const dir = await mkdtemp(path.join(tmpdir(), "mr-"));
  try {
    await mkdir(path.join(dir, ".deepcoder"), { recursive: true });
    await writeFile(path.join(dir, ".deepcoder", "config.json"),
      JSON.stringify({ models: { fallbacks: { plan: ["review"], review: ["plan"] } } }), "utf8");
    const fc = loadFileConfig(dir);
    assert.equal(fc.models?.fallbacks, undefined, "cyclic fallbacks must be dropped");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("6. plan role resolves to the reasoner model and is a read-only (zero-tool) role", () => {
  assert.equal(new ModelRouter(cfg()).resolve("plan").model, "deepseek-reasoner");
  assert.ok(READONLY_ROLES.has("plan"), "/plan has no tools → fallback-safe");
});

test("7. main-agent 'edit' role resolves to config.model and is NOT a read-only role", () => {
  assert.equal(new ModelRouter(cfg()).resolve("edit").model, "deepseek-chat");
  assert.equal(READONLY_ROLES.has("edit"), false);
});

test("8. reviewer/researcher/triage/explorer map to distinct roles", () => {
  assert.equal(reviewer.role, "review");
  assert.equal(researcher.role, "research");
  assert.equal(testTriage.role, "triage");
  assert.equal(explorer.role, "explore");
  assert.equal(new Set([reviewer.role, researcher.role, testTriage.role, explorer.role]).size, 4);
});

test("9. a read-only role can fall back when configured; mutating roles are not fallback-safe", () => {
  const r = new ModelRouter(cfg(), { fallbacks: { review: ["edit"] } });
  assert.deepEqual(r.fallbackChain("review"), ["edit"]);
  assert.ok(READONLY_ROLES.has("review"));     // review may fall back
});

test("10. edit/delegate (mutating) roles are NOT fallback-safe (no silent mutating retry)", () => {
  assert.equal(READONLY_ROLES.has("edit"), false);
  assert.equal(READONLY_ROLES.has("delegate"), false);
});

test("11. explain() is bounded and never carries an API key", () => {
  const c = cfg({ provider: "deepseek", model: "m" });
  (c as unknown as { apiKey: string }).apiKey = "sk-SECRET-KEY-123";
  const routes = new ModelRouter(c).explain();
  assert.equal(routes.length, ALL_ROLES.length);          // bounded: one per role
  assert.doesNotMatch(JSON.stringify(routes), /SECRET-KEY/, "routing table must not leak the key");
});

test("12. a resolved route carries role/provider/model but no secret", () => {
  const c = cfg();
  (c as unknown as { apiKey: string }).apiKey = "sk-LEAKME";
  const route = new ModelRouter(c).resolve("edit");
  assert.ok(route.role && route.provider && route.model);
  assert.doesNotMatch(JSON.stringify(route), /LEAKME/);
});
