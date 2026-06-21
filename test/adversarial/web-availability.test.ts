/**
 * Phase 10E availability — the web tools are actually registered (callable by the
 * agent) ONLY when web is enabled in config. Default-off: no web tools exist.
 *
 * This pins the shared-file wiring: loadConfig exposes a `web` block, and
 * buildSession registers web_fetch/web_search through createWebTools when enabled.
 *
 * RED ANCHOR: loadConfig has no `web` field yet, so the config assertion + the
 * enabled-registration both fail on baseline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config.js";
import { buildSession } from "../../src/runtime/sessionFactory.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

test("[10E-avail-config] loadConfig exposes a web block, disabled by default", () => {
  const c = loadConfig();
  assert.equal(c.web.enabled, false);
  assert.ok(Array.isArray(c.web.blockedDomains));
});

test("[10E-avail-default] NO web tools are registered when web is disabled (default)", async () => {
  const s = await buildSession(loadConfig());
  assert.equal(s.registry.get("web_fetch"), undefined);
  assert.equal(s.registry.get("web_search"), undefined);
});

test("[10E-avail-enabled] enabling web registers web_fetch + web_search", async () => {
  const s = await buildSession(loadConfig({ web: { enabled: true } as never }));
  assert.ok(s.registry.get("web_fetch"), "web_fetch registered");
  assert.ok(s.registry.get("web_search"), "web_search registered");
});
