import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderSources,
  renderTiers,
  resolveIncludes,
  type InstructionSource,
} from "../../src/context/instructionTiers.js";

test("[SECURITY] an @include cycle (A->B->A) terminates without looping or throwing", () => {
  const files: Record<string, string> = {
    "a.md": "A-top\n@include b.md",
    "b.md": "B-top\n@include a.md",
  };
  let result: ReturnType<typeof resolveIncludes>;
  assert.doesNotThrow(() => {
    result = resolveIncludes("@include a.md", (p) => files[p], {
      isAllowed: () => true,
      maxDepth: 50,
    });
  });
  // a and b each expand once; the back-edge to a is detected as a cycle
  assert.ok(result!.text.includes("A-top"));
  assert.ok(result!.text.includes("B-top"));
  assert.ok(result!.skipped.some((s) => s.reason === "cycle" && s.path === "a.md"));
});

test("[SECURITY] a file that includes itself does not loop", () => {
  const files: Record<string, string> = {
    "self.md": "self-body\n@include self.md",
  };
  const { text, skipped } = resolveIncludes("@include self.md", (p) => files[p], {
    isAllowed: () => true,
    maxDepth: 100,
  });
  assert.equal(text.match(/self-body/g)?.length, 1); // exactly one expansion
  assert.ok(skipped.some((s) => s.reason === "cycle" && s.path === "self.md"));
});

test("[SECURITY] @include outside the allowlist is refused, not expanded", () => {
  const reads: string[] = [];
  const reader = (p: string): string | undefined => {
    reads.push(p);
    return "SECRET-CONTENTS";
  };
  // allow only paths under rules/, with no traversal
  const isAllowed = (p: string) =>
    p.startsWith("rules/") && !p.includes("..") && !p.startsWith("/");

  const { text, skipped } = resolveIncludes(
    "@include /etc/passwd\n@include ../../x\n@include rules/ok.md",
    reader,
    { isAllowed, maxDepth: 4 },
  );

  // refused targets were never read
  assert.ok(!reads.includes("/etc/passwd"));
  assert.ok(!reads.includes("../../x"));
  assert.ok(reads.includes("rules/ok.md"));
  // disallowed directives are replaced by an inert skip marker, not expanded
  assert.ok(text.includes("skipped (not allowed): @include /etc/passwd"));
  assert.ok(text.includes("skipped (not allowed): @include ../../x"));
  assert.equal(
    skipped.filter((s) => s.reason === "not-allowed").map((s) => s.path).sort().join(","),
    "../../x,/etc/passwd",
  );
});

test("[SECURITY] include depth bomb stops at the configured max depth", () => {
  // a chain of 1000 nested includes; reader synthesizes each level on demand
  const reader = (p: string): string | undefined => {
    const n = Number(p.replace(/\D/g, ""));
    if (Number.isNaN(n)) return undefined;
    return `level-${n}\n@include level${n + 1}.md`;
  };
  const { text, skipped } = resolveIncludes("@include level0.md", reader, {
    isAllowed: () => true,
    maxDepth: 5,
  });
  // expands exactly maxDepth levels, then stops
  assert.ok(text.includes("level-0"));
  assert.ok(text.includes("level-4"));
  assert.ok(!text.includes("level-5"));
  assert.ok(skipped.some((s) => s.reason === "depth"));
  // bounded: exactly one depth-skip at the frontier
  assert.equal(skipped.filter((s) => s.reason === "depth").length, 1);
});

test("[SECURITY] managed tier always outranks workspace/local regardless of input order", () => {
  // adversarial input: lower-authority tiers placed first, hoping to win.
  const sources: InstructionSource[] = [
    { tier: "local", origin: "AGENTS.local.md", text: "network: allow" },
    { tier: "workspace", origin: "AGENTS.md", text: "network: ask" },
    { tier: "managed", origin: "/etc/deepcoder/policy.md", text: "network: deny" },
  ];
  const ordered = orderSources(sources);
  assert.equal(ordered[0].tier, "managed");
  assert.ok(ordered.findIndex((s) => s.tier === "managed") < ordered.findIndex((s) => s.tier === "workspace"));
  assert.ok(ordered.findIndex((s) => s.tier === "workspace") < ordered.findIndex((s) => s.tier === "local"));

  const rendered = renderTiers(sources);
  // managed rule is rendered first / highest, regardless of arrival order
  assert.ok(rendered.indexOf("network: deny") < rendered.indexOf("network: ask"));
  assert.ok(rendered.indexOf("network: ask") < rendered.indexOf("network: allow"));
  assert.ok(rendered.includes("[managed]"));
});
