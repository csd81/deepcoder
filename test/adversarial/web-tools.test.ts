/**
 * Phase 10E — web tools factory (pure). Builds the registerable web tools from a
 * resolved web config; registry.ts just calls this (the central edit is a separate
 * in-house step). Returns NO tools when web is disabled.
 *
 * RED ANCHOR: imports from src/tools/webTools.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createWebTools } from "../../src/tools/webTools.js";

test("[10E-tools-disabled] returns no tools when web is disabled (default-off)", () => {
  const tools = createWebTools({ enabled: false, allowedDomains: [], blockedDomains: [], searchProvider: "none" });
  assert.equal(tools.length, 0);
});

test("[10E-tools-enabled] enabled -> web_fetch + web_search tools, both read-only", () => {
  const tools = createWebTools({ enabled: true, allowedDomains: ["x.com"], blockedDomains: [], searchProvider: "none" });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
  assert.ok(tools.every((t) => t.kind === "read-only"), "web tools are read-only");
});
