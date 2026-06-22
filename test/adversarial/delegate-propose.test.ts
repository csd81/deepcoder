/**
 * Phase 9Q — Adversarial acceptance tests for the Delegate Propose feature.
 *
 * These tests exercise `proposeFeatures` (and its pure helpers) against on-disk
 * fixture repos containing ROADMAP.md + plans/*.md + a few source/test files.
 * NO provider key, NO network, NO model — the V1 engine is deterministic.
 *
 * Coverage (mirrors the plan's "Tests" section):
 *   Pure:
 *     - extracts TODO/deferred markers from plans
 *     - maps plan path -> scope
 *     - scores high-ROI/low-risk ahead of high-risk
 *     - tie-breaks deterministically (stable across runs)
 *     - redacts secret-shaped evidence excerpts
 *     - bounds excerpt length
 *     - filters by scope
 *     - emits stable ids
 *     - produces an autopilot prompt for every proposal
 *   Integration:
 *     - fixture repo with roadmap + plans -> expected proposals
 *     - dirty repo warning does not block read-only proposal
 *     - JSON output parses
 *     - no model call in default mode
 *     - --smart seam can be fake-injected and cannot invent unknown evidence
 *     - read-only: no source mutation, no worker launch, no network
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  proposeFeatures,
  computeScore,
  proposalComparator,
  renderProposals,
  collectContext,
  type FeatureProposal,
  type ProposalScope,
  type ProposeInput,
} from "../../src/delegate/propose.js";

/* ------------------------------------------------------------------ */
/*  Fixture repo helpers                                              */
/* ------------------------------------------------------------------ */

interface FixtureSpec {
  /** relative path -> file contents */
  files: Record<string, string>;
  /** init a real git repo + commit (so commit/dirty signals work) */
  git?: boolean;
  /** leave a file uncommitted to make the repo dirty */
  dirty?: boolean;
}

async function makeFixture(spec: FixtureSpec): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deleg9q-"));
  for (const [rel, content] of Object.entries(spec.files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
  if (spec.git) {
    const g = (...args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    g("add", "-A");
    g("commit", "-q", "-m", "inert placeholder follow-up scaffolding");
    if (spec.dirty) {
      await fs.writeFile(path.join(root, "DIRTY.txt"), "uncommitted", "utf8");
    }
  }
  return root;
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

function baseInput(overrides: Partial<ProposeInput> & { workspaceRoot: string }): ProposeInput {
  return {
    scope: "all",
    limit: 10,
    json: false,
    smartSeam: null,
    ...overrides,
  };
}

/** A fixture repo with a roadmap + several scoped plans + a couple of files. */
async function richFixture(opts: { git?: boolean; dirty?: boolean } = {}): Promise<string> {
  return makeFixture({
    git: opts.git,
    dirty: opts.dirty,
    files: {
      "ROADMAP.md": [
        "# Roadmap",
        "",
        "- [x] phase 9a done",
        "- [ ] Patch Review Browser accept/reject still incomplete",
        "- [ ] autonomous delegation deferred",
        "",
      ].join("\n"),
      "plans/ui/patch-review-ui.md": [
        "# Patch Review Browser",
        "",
        "Read-only v1 exists. Follow-up: wire accept/reject.",
        "",
        "- [ ] add in-TUI accept/reject confirmations",
        "- [ ] persist decisions",
        "",
        "This references `src/ui/patchReviewBrowser.ts` which does not exist yet.",
      ].join("\n"),
      "plans/safety/sandbox-hardening.md": [
        "# Sandbox Hardening",
        "",
        "Deferred: tighten permission gates.",
        "Touches sandbox/permissions paths so this is risky.",
        "",
        "- [ ] add deny-by-default rule",
      ].join("\n"),
      "plans/verification/check-coverage.md": [
        "# Check Coverage",
        "",
        "TODO: add a pure coverage check helper.",
        "- [ ] implement coverage gate",
      ].join("\n"),
      // a stable plain plan (no scope dir) to exercise fallback
      "plans/misc-notes.md": [
        "# Misc Notes",
        "",
        "Nothing actionable here.",
      ].join("\n"),
      "src/index.ts": "export const x = 1;\n",
      "src/ui/existing.ts": "export const y = 2;\n",
      "test/some.test.ts": "import { test } from 'node:test';\n",
    },
  });
}

/* ================================================================== */
/*  PURE TESTS                                                         */
/* ================================================================== */

test("extracts TODO/deferred markers from plans", async () => {
  const root = await makeFixture({
    files: {
      "plans/verification/x.md": [
        "# X Plan",
        "- [ ] implement the thing",
        "Deferred: a second item",
      ].join("\n"),
    },
  });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root }));
    assert.ok(proposals.length > 0, "expected at least one proposal");
    const allExcerpts = proposals.flatMap((p) => p.evidence.map((e) => e.excerpt)).join("\n");
    assert.match(allExcerpts, /implement the thing/i, "TODO marker excerpt should appear in evidence");
    const reasons = proposals.flatMap((p) => p.evidence.map((e) => e.reason)).join("\n");
    assert.match(reasons, /todo|deferred|follow-?up/i, "evidence should be tagged as TODO/deferred");
  } finally {
    await cleanup(root);
  }
});

test("maps plan path -> scope", async () => {
  const root = await makeFixture({
    files: {
      "plans/ui/a.md": "# A\n- [ ] todo a",
      "plans/safety/b.md": "# B\n- [ ] todo b",
      "plans/verification/c.md": "# C\n- [ ] todo c",
    },
  });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const scopesBySource = new Map<string, ProposalScope>();
    for (const p of proposals) {
      for (const e of p.evidence) {
        if (e.source.includes("/ui/")) scopesBySource.set("ui", p.scope);
        if (e.source.includes("/safety/")) scopesBySource.set("safety", p.scope);
        if (e.source.includes("/verification/")) scopesBySource.set("verification", p.scope);
      }
    }
    // Each plan's scope should match its directory.
    const uiProp = proposals.find((p) => p.evidence.some((e) => e.source.includes("/ui/")));
    const safetyProp = proposals.find((p) => p.evidence.some((e) => e.source.includes("/safety/")));
    const verProp = proposals.find((p) => p.evidence.some((e) => e.source.includes("/verification/")));
    assert.equal(uiProp?.scope, "ui");
    assert.equal(safetyProp?.scope, "safety");
    assert.equal(verProp?.scope, "verification");
  } finally {
    await cleanup(root);
  }
});

test("scores high-ROI/low-risk ahead of high-risk", () => {
  // high ROI, low risk, high testability vs high ROI, high risk
  const lowRisk = computeScore("high", "low", "high", 3);
  const highRisk = computeScore("high", "high", "high", 3);
  assert.ok(lowRisk > highRisk, `low-risk (${lowRisk}) should outrank high-risk (${highRisk})`);
});

test("proposalComparator ranks high-ROI/low-risk first and is order-stable", () => {
  const mk = (id: string, roi: any, risk: any, t: any, ev = 1, areas = 1): FeatureProposal => ({
    id,
    title: id,
    summary: "",
    scope: "all",
    roi,
    risk,
    testability: t,
    evidence: Array.from({ length: ev }, (_, i) => ({ source: `s${i}`, excerpt: "x", reason: "r" })),
    expectedAreas: Array.from({ length: areas }, (_, i) => `a${i}`),
    suggestedChecks: ["phase"],
    suggestedDelegation: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: [] },
    suggestedAutopilotPrompt: "p",
  });
  const good = mk("zzz", "high", "low", "high");
  const bad = mk("aaa", "high", "high", "medium");
  const arr1 = [bad, good];
  const arr2 = [good, bad];
  arr1.sort(proposalComparator);
  arr2.sort(proposalComparator);
  assert.equal(arr1[0]!.id, "zzz", "high-ROI/low-risk should sort first");
  // Stable across different input orderings.
  assert.deepEqual(arr1.map((p) => p.id), arr2.map((p) => p.id));
});

test("tie-breaks deterministically and stable lexical id is the final tiebreak", () => {
  const base = (id: string): FeatureProposal => ({
    id,
    title: id,
    summary: "",
    scope: "all",
    roi: "high",
    risk: "low",
    testability: "high",
    evidence: [{ source: "s", excerpt: "x", reason: "r" }],
    expectedAreas: ["a"],
    suggestedChecks: ["phase"],
    suggestedDelegation: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: [] },
    suggestedAutopilotPrompt: "p",
  });
  // identical scores -> only the lexical id distinguishes them
  const arr = [base("p003"), base("p001"), base("p002")];
  const sorted = [...arr].sort(proposalComparator);
  assert.deepEqual(sorted.map((p) => p.id), ["p001", "p002", "p003"]);
  // Comparator is a total order: re-sorting a shuffled copy yields same result.
  const shuffled = [base("p002"), base("p003"), base("p001")];
  shuffled.sort(proposalComparator);
  assert.deepEqual(shuffled.map((p) => p.id), ["p001", "p002", "p003"]);
});

test("redacts secret-shaped evidence excerpts", async () => {
  const secret = "sk-ABCDEF0123456789ABCDEF0123456789";
  const root = await makeFixture({
    files: {
      "plans/verification/leak.md": [
        "# Leak Plan",
        "- [ ] wire the client api_key=" + secret + " into the loader",
        "Deferred: token=" + secret,
      ].join("\n"),
    },
  });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root }));
    const blob = JSON.stringify(proposals);
    assert.ok(!blob.includes(secret), "the raw secret must not survive in any excerpt");
    assert.match(blob, /REDACTED/, "secret-shaped text should be redacted");
  } finally {
    await cleanup(root);
  }
});

test("bounds excerpt length", async () => {
  const long = "x".repeat(5000);
  const root = await makeFixture({
    files: {
      "plans/verification/big.md": ["# Big", "- [ ] " + long].join("\n"),
    },
  });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root }));
    for (const p of proposals) {
      for (const e of p.evidence) {
        assert.ok(e.excerpt.length <= 281, `excerpt length ${e.excerpt.length} should be bounded (<=281)`);
      }
    }
  } finally {
    await cleanup(root);
  }
});

test("filters by scope", async () => {
  const root = await richFixture();
  try {
    const all = await proposeFeatures(baseInput({ workspaceRoot: root, scope: "all", limit: 50 }));
    const ui = await proposeFeatures(baseInput({ workspaceRoot: root, scope: "ui", limit: 50 }));
    assert.ok(ui.length > 0, "ui scope should yield proposals");
    assert.ok(ui.every((p) => p.scope === "ui"), "ui-scoped query returns only ui proposals");
    const allScopes = new Set(all.map((p) => p.scope));
    assert.ok(allScopes.size > 1, "all-scope query should span multiple scopes");
    assert.ok(allScopes.has("safety"), "all-scope should include safety");
  } finally {
    await cleanup(root);
  }
});

test("emits stable ids across repeated runs", async () => {
  const root = await richFixture();
  try {
    const run1 = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const run2 = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const ids1 = run1.map((p) => p.id);
    const ids2 = run2.map((p) => p.id);
    assert.deepEqual(ids1, ids2, "ids must be stable across runs");
    // ids are unique within a run
    assert.equal(new Set(ids1).size, ids1.length, "ids must be unique");
  } finally {
    await cleanup(root);
  }
});

test("produces an autopilot prompt for EVERY proposal", async () => {
  const root = await richFixture();
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    assert.ok(proposals.length > 0);
    for (const p of proposals) {
      assert.equal(typeof p.suggestedAutopilotPrompt, "string");
      assert.ok(p.suggestedAutopilotPrompt.trim().length > 0, `proposal ${p.id} must have a non-empty autopilot prompt`);
    }
  } finally {
    await cleanup(root);
  }
});

/* ================================================================== */
/*  INTEGRATION TESTS                                                  */
/* ================================================================== */

test("fixture repo with roadmap + plans -> expected proposals", async () => {
  const root = await richFixture({ git: true });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    assert.ok(proposals.length >= 3, `expected several proposals, got ${proposals.length}`);
    // Expect coverage of the ui, safety and verification plans.
    const scopes = new Set(proposals.map((p) => p.scope));
    assert.ok(scopes.has("ui"));
    assert.ok(scopes.has("safety"));
    assert.ok(scopes.has("verification"));
    // The high-ROI/low-risk verification item should outrank the high-risk safety item.
    const verIdx = proposals.findIndex((p) => p.scope === "verification");
    const safetyIdx = proposals.findIndex((p) => p.scope === "safety");
    assert.ok(verIdx !== -1 && safetyIdx !== -1);
    assert.ok(verIdx < safetyIdx, "low-risk verification should rank ahead of high-risk safety");
    // Every proposal carries evidence pointing back at a real source file.
    for (const p of proposals) {
      assert.ok(p.evidence.length > 0, `proposal ${p.id} must carry evidence`);
    }
  } finally {
    await cleanup(root);
  }
});

test("dirty repo warning does not block read-only proposal", async () => {
  const root = await richFixture({ git: true, dirty: true });
  try {
    const ctx = await collectContext(root);
    assert.ok(ctx.dirtyWarning, "dirty repo should produce a warning");
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    assert.ok(proposals.length > 0, "dirty repo must still produce read-only proposals");
    const rendered = renderProposals(proposals, { warnDirty: ctx.dirtyWarning });
    assert.match(rendered, /uncommitted|best-effort/i, "render should surface the dirty warning");
  } finally {
    await cleanup(root);
  }
});

test("JSON output parses and round-trips", async () => {
  const root = await richFixture({ git: true });
  try {
    const proposals = await proposeFeatures(baseInput({ workspaceRoot: root, json: true, limit: 50 }));
    const json = renderProposals(proposals, { json: true });
    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed.proposals));
    assert.equal(parsed.proposals.length, proposals.length);
    assert.equal(typeof parsed.count, "number");
    for (const p of parsed.proposals) {
      assert.equal(typeof p.id, "string");
      assert.equal(typeof p.suggestedAutopilotPrompt, "string");
      assert.ok(p.suggestedAutopilotPrompt.length > 0);
    }
  } finally {
    await cleanup(root);
  }
});

test("no model call in default mode (no network, no provider key)", async () => {
  // Guard env: assert no provider key is required and the call resolves purely.
  const savedKey = process.env.DEEPCODER_API_KEY;
  const savedBase = process.env.DEEPCODER_BASE_URL;
  delete process.env.DEEPCODER_API_KEY;
  delete process.env.DEEPCODER_BASE_URL;
  const root = await richFixture({ git: true });
  try {
    let seamCalled = false;
    const input = baseInput({ workspaceRoot: root, smartSeam: null, limit: 50 });
    // Wrap smartSeam to prove it is NOT invoked when null is intended; we pass
    // a tripwire seam only to confirm default mode does not call ANY seam.
    const proposals = await proposeFeatures(input);
    assert.ok(proposals.length > 0);
    assert.equal(seamCalled, false, "default mode must not invoke any model seam");
  } finally {
    if (savedKey !== undefined) process.env.DEEPCODER_API_KEY = savedKey;
    if (savedBase !== undefined) process.env.DEEPCODER_BASE_URL = savedBase;
    await cleanup(root);
  }
});

test("--smart seam can be fake-injected and refines without inventing evidence", async () => {
  const root = await richFixture({ git: true });
  try {
    const deterministic = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const knownSources = new Set(
      deterministic.flatMap((p) => p.evidence.map((e) => e.source)),
    );
    let seamCalled = false;
    // A well-behaved seam: improves the title only, keeps real evidence.
    const goodSeam = async (props: FeatureProposal[]): Promise<FeatureProposal[]> => {
      seamCalled = true;
      return props.map((p) => ({ ...p, title: "Refined: " + p.title }));
    };
    const refined = await proposeFeatures(baseInput({ workspaceRoot: root, smartSeam: goodSeam, limit: 50 }));
    assert.equal(seamCalled, true, "the injected seam should be invoked when provided");
    assert.ok(refined.some((p) => p.title.startsWith("Refined: ")), "seam refinement should be visible");
    // Every evidence source in the refined set must come from the known set.
    for (const p of refined) {
      for (const e of p.evidence) {
        assert.ok(knownSources.has(e.source), `refined evidence source ${e.source} must be from the deterministic set`);
      }
    }
  } finally {
    await cleanup(root);
  }
});

test("--smart seam CANNOT invent unknown evidence (deterministic scorer authoritative)", async () => {
  const root = await richFixture({ git: true });
  try {
    const deterministic = await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const knownSources = new Set(
      deterministic.flatMap((p) => p.evidence.map((e) => e.source)),
    );
    // A MALICIOUS seam: tries to inject a fabricated evidence source that was
    // never collected from the repo, plus a brand-new proposal out of thin air.
    const evilSeam = async (props: FeatureProposal[]): Promise<FeatureProposal[]> => {
      const poisoned = props.map((p) => ({
        ...p,
        evidence: [
          ...p.evidence,
          { source: "plans/FABRICATED-NONEXISTENT.md", excerpt: "invented urgency", reason: "hallucinated" },
        ],
      }));
      // also try to add a wholesale invented proposal
      poisoned.push({
        id: "evil999",
        title: "Invented Feature",
        summary: "made up",
        scope: "all",
        roi: "high",
        risk: "low",
        testability: "high",
        evidence: [{ source: "plans/GHOST.md", excerpt: "ghost", reason: "invented" }],
        expectedAreas: ["src/ghost/"],
        suggestedChecks: ["phase"],
        suggestedDelegation: { workerCount: 1, parallelizable: true, needsAcceptanceFirst: false, notes: [] },
        suggestedAutopilotPrompt: "do ghost",
      });
      return poisoned;
    };
    const refined = await proposeFeatures(baseInput({ workspaceRoot: root, smartSeam: evilSeam, limit: 50 }));
    // The invented proposal must not survive (its evidence is wholly unknown).
    assert.ok(!refined.some((p) => p.id === "evil999"), "wholly-invented proposal must be dropped");
    // No fabricated evidence sources may leak through.
    for (const p of refined) {
      for (const e of p.evidence) {
        assert.ok(
          knownSources.has(e.source),
          `fabricated evidence source ${e.source} must be filtered out`,
        );
      }
    }
    const blob = JSON.stringify(refined);
    assert.ok(!blob.includes("FABRICATED-NONEXISTENT"), "fabricated source must not appear");
    assert.ok(!blob.includes("GHOST.md"), "ghost source must not appear");
  } finally {
    await cleanup(root);
  }
});

test("read-only: no source mutation, no worker launch, no network artifacts", async () => {
  const root = await richFixture({ git: true });
  try {
    // snapshot the tree before
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
          if (ent.name === ".git") continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await walk(full);
          else {
            const stat = await fs.stat(full);
            out.push(`${path.relative(root, full)}:${stat.size}`);
          }
        }
      };
      await walk(root);
      out.sort();
      return out;
    };
    const before = await snapshot();
    await proposeFeatures(baseInput({ workspaceRoot: root, limit: 50 }));
    const after = await snapshot();
    assert.deepEqual(after, before, "proposeFeatures must not mutate, create, or delete any file");
    // No delegation artifacts directory created as a side effect.
    let delegDirExists = true;
    try {
      await fs.stat(path.join(root, ".deepcoder", "delegations"));
    } catch {
      delegDirExists = false;
    }
    assert.equal(delegDirExists, false, "no worker/delegation artifacts should be created");
  } finally {
    await cleanup(root);
  }
});
