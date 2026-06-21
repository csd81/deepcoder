/**
 * Phase 10E slice 5 — web tool access decision (pure, default-deny gate).
 *
 * The safety gate that decides whether a subagent profile may use the web tools.
 * Default-deny: web tools are granted ONLY when web is enabled in config AND the
 * profile EXPLICITLY opts in (strict boolean true). This resists accidental grants
 * and injected/truthy-but-not-true opt-ins. The profiles.ts wiring is a separate
 * in-house follow-up; this is the pure decision core.
 *
 * Deliverables (each tagged [10E5-*]):
 *   [10E5-disabled]  web disabled in config -> no web tools, even if profile opts in
 *   [10E5-optin]     enabled + explicit opt-in -> [web_search, web_fetch]
 *   [10E5-default]   enabled + no opt-in -> [] (default-deny; explorer/reviewer get nothing)
 *   [10E5-strict]    a truthy-but-not-true opt-in ("yes", 1, {}) does NOT grant access
 *
 * RED ANCHOR: imports from src/web/access.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveWebTools, WEB_TOOL_NAMES } from "../../src/web/access.js";

test("[10E5-disabled] web disabled -> no tools even with opt-in", () => {
  const tools = resolveWebTools({ webEnabled: false, profileWebOptIn: true });
  assert.deepEqual(tools, []);
});

test("[10E5-optin] enabled + explicit opt-in -> both web tools", () => {
  const tools = resolveWebTools({ webEnabled: true, profileWebOptIn: true });
  assert.deepEqual([...tools].sort(), [...WEB_TOOL_NAMES].sort());
});

test("[10E5-default] enabled + no opt-in -> [] (default-deny)", () => {
  const tools = resolveWebTools({ webEnabled: true, profileWebOptIn: false });
  assert.deepEqual(tools, []);
});

test("[10E5-strict] a truthy-but-not-true opt-in does NOT grant web access", () => {
  for (const sneaky of ["yes", 1, {}, "true", [] as unknown, "1", "on"]) {
    const tools = resolveWebTools({ webEnabled: true, profileWebOptIn: sneaky as unknown as boolean });
    assert.deepEqual(tools, [], `opt-in ${JSON.stringify(sneaky)} must not grant access`);
  }
});
