import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_PRECEDENCE,
  tierRank,
  orderSources,
  renderTiers,
  resolveIncludes,
  type InstructionSource,
} from "../src/context/instructionTiers.js";

test("precedence ranking covers all five tiers, highest authority first", () => {
  assert.deepEqual(
    [...TIER_PRECEDENCE],
    ["managed", "user", "workspace", "local", "path"],
  );
  assert.equal(tierRank("managed"), 0);
  assert.equal(tierRank("path"), 4);
  // strictly increasing in declared order
  for (let i = 1; i < TIER_PRECEDENCE.length; i++) {
    assert.ok(tierRank(TIER_PRECEDENCE[i - 1]) < tierRank(TIER_PRECEDENCE[i]));
  }
});

test("orderSources is stable and ordered by tier precedence then origin", () => {
  const input: InstructionSource[] = [
    { tier: "path", origin: "deep/b.md", text: "p2" },
    { tier: "managed", origin: "/etc/policy.md", text: "m" },
    { tier: "workspace", origin: "AGENTS.md", text: "w" },
    { tier: "path", origin: "deep/a.md", text: "p1" },
    { tier: "user", origin: "~/.deepcoder/instructions.md", text: "u" },
    { tier: "local", origin: "AGENTS.local.md", text: "l" },
  ];
  const ordered = orderSources(input);
  assert.deepEqual(
    ordered.map((s) => s.tier),
    ["managed", "user", "workspace", "local", "path", "path"],
  );
  // within the path tier, ordered by origin lexicographically
  const paths = ordered.filter((s) => s.tier === "path").map((s) => s.origin);
  assert.deepEqual(paths, ["deep/a.md", "deep/b.md"]);
  // does not mutate the input
  assert.equal(input[0].origin, "deep/b.md");
});

test("orderSources keeps input order for full ties (stable)", () => {
  const input: InstructionSource[] = [
    { tier: "workspace", origin: "same.md", text: "first" },
    { tier: "workspace", origin: "same.md", text: "second" },
    { tier: "workspace", origin: "same.md", text: "third" },
  ];
  const ordered = orderSources(input);
  assert.deepEqual(ordered.map((s) => s.text), ["first", "second", "third"]);
});

test("renderTiers attributes each source with tier and origin and groups by tier", () => {
  const sources: InstructionSource[] = [
    { tier: "workspace", origin: "AGENTS.md", text: "Use pnpm." },
    { tier: "managed", origin: "/etc/deepcoder/policy.md", text: "No network." },
    { tier: "path", origin: "src/api/AGENTS.md", text: "Validate inputs." },
  ];
  const out = renderTiers(sources);
  // every tier + origin is attributed
  assert.ok(out.includes("[managed]"));
  assert.ok(out.includes("[workspace]"));
  assert.ok(out.includes("[path]"));
  assert.ok(out.includes("/etc/deepcoder/policy.md"));
  assert.ok(out.includes("AGENTS.md"));
  assert.ok(out.includes("src/api/AGENTS.md"));
  // bodies present
  assert.ok(out.includes("No network."));
  assert.ok(out.includes("Validate inputs."));
  // grouped by precedence: managed body appears before workspace body
  assert.ok(out.indexOf("No network.") < out.indexOf("Use pnpm."));
  assert.ok(out.indexOf("Use pnpm.") < out.indexOf("Validate inputs."));
});

test("renderTiers is deterministic and bounded", () => {
  const sources: InstructionSource[] = [
    { tier: "managed", origin: "a.md", text: "X".repeat(100) },
    { tier: "workspace", origin: "b.md", text: "Y".repeat(100) },
  ];
  const a = renderTiers(sources);
  const b = renderTiers(sources);
  assert.equal(a, b);
  // a budget that fits only the highest-authority chunk drops the rest
  const justManaged = renderTiers([sources[0]]);
  const bounded = renderTiers(sources, Buffer.byteLength(justManaged) + 5);
  assert.ok(bounded.includes("X".repeat(100)));
  assert.ok(!bounded.includes("Y".repeat(100)));
});

test("resolveIncludes expands a simple include via the injected reader", () => {
  const files: Record<string, string> = {
    "rules/style.md": "Two-space indentation.",
  };
  const { text, skipped } = resolveIncludes(
    "Project rules:\n@include rules/style.md\nDone.",
    (p) => files[p],
    { isAllowed: () => true, maxDepth: 4 },
  );
  assert.ok(text.includes("Two-space indentation."));
  assert.ok(text.includes("Project rules:"));
  assert.ok(text.includes("Done."));
  assert.deepEqual(skipped, []);
});

test("resolveIncludes honors the depth limit", () => {
  const files: Record<string, string> = {
    "a.md": "A\n@include b.md",
    "b.md": "B\n@include c.md",
    "c.md": "C",
  };
  const { text, skipped } = resolveIncludes(
    "@include a.md",
    (p) => files[p],
    { isAllowed: () => true, maxDepth: 2 },
  );
  // depth 1 (a) and depth 2 (b) expand; c is at depth 3 -> skipped
  assert.ok(text.includes("A"));
  assert.ok(text.includes("B"));
  assert.ok(!text.includes("C"));
  assert.deepEqual(skipped, [{ path: "c.md", reason: "depth" }]);
});
