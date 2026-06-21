/**
 * Phase 10E — web config module (pure). Standalone schema/defaults/env so config.ts
 * just spreads it in (the central edit is a separate in-house step).
 *
 * RED ANCHOR: imports from src/config/webConfig.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { defaultWebConfig, webConfigFromEnv } from "../../src/config/webConfig.js";

test("[10E-cfg-default] disabled by default with safe caps + metadata IP blocked", () => {
  const c = defaultWebConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.searchProvider, "none");
  assert.ok(c.maxFetchBytes > 0 && c.maxReturnedChars > 0 && c.timeoutMs > 0);
  assert.ok(c.blockedDomains.includes("169.254.169.254"), "metadata IP blocked by default");
});

test("[10E-cfg-env] env overrides enable + provider + allow/block domains", () => {
  const c = webConfigFromEnv({
    DEEPCODER_WEB: "1",
    DEEPCODER_WEB_SEARCH_PROVIDER: "tavily",
    DEEPCODER_WEB_ALLOWED_DOMAINS: "a.com, b.com",
  });
  assert.equal(c.enabled, true);
  assert.equal(c.searchProvider, "tavily");
  assert.deepEqual(c.allowedDomains, ["a.com", "b.com"]);
});

test("[10E-cfg-off] DEEPCODER_WEB=0 force-disables even with other vars set", () => {
  const c = webConfigFromEnv({ DEEPCODER_WEB: "0", DEEPCODER_WEB_SEARCH_PROVIDER: "tavily" });
  assert.equal(c.enabled, false);
});
