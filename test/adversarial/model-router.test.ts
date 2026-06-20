/**
 * Phase 10F — model/task router. SEED (red-first) anchor: pins the core
 * default-preserving contract so a delegated worker MUST implement the router
 * (no green-check no-op), then EXTENDS this file with the remaining 12 cases
 * from plans/phase10f-model-task-router-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../../src/models/router.js";
import { loadConfig } from "../../src/config/config.js";

test("[router-edit-default] resolve('edit') returns the configured edit model (default-preserving)", () => {
  const cfg = loadConfig({ workspaceRoot: "/tmp" });
  const router = new ModelRouter(cfg);
  const route = router.resolve("edit");
  assert.equal(route.role, "edit");
  assert.equal(route.model, cfg.model, "with no role config, edit must resolve to config.model");
});
