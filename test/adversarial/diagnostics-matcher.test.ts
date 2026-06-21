/**
 * Phase 7I — post-write diagnostic interceptor. SEED (red-first): pins the pure
 * matcher contract (a changed .ts file matches a **/*.ts rule) so a delegated
 * worker MUST implement the diagnostics core (no green-check no-op), then EXTENDS
 * with the rest from plans/phase7i-dynamic-linter-typecheck-autofix-interceptor-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRules } from "../../src/diagnostics/matcher.js";

test("[diag-match-ts] a changed .ts file matches a **/*.ts rule (and a .md does not)", () => {
  const rules = [{ name: "ts", match: ["**/*.ts", "**/*.tsx"], command: "npm run typecheck" }];
  const matched = matchRules(["src/foo.ts", "README.md"], rules);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].rule.name, "ts");
  assert.deepEqual(matched[0].files, ["src/foo.ts"]);
});
